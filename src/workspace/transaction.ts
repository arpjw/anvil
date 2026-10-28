import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { workspacePath } from '../tools/workspace_path.js';
import { commitContent, recordCommitted } from '../shadow/workspace.js';
import { applySelectedHunks, generateDiff } from '../diff/engine.js';
import { uiStream } from '../ui/stream.js';
import { snapshotProject, validateCandidate } from './batch-validation.js';
import { lockWorkspace, workspaceStatePath } from './lock.js';

export interface FileEdit { path: string; content: string | null }
interface Entry { path: string; before: string | null; after: string | null; mode: number }
interface Journal { version: 1; root: string; sessionId: string; id: string; state: 'applying' | 'committed'; entries: Entry[]; createdDirs: string[] }
export interface TransactionOptions {
  validate?: (candidate: string, paths: string[]) => Promise<string[]> | string[];
  beforeApply?: (index: number) => void;
}
export interface TransactionResult { status: 'applied' | 'rejected'; paths: string[]; id: string }

export function parseEdits(value: unknown): FileEdit[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Provide between 1 and 100 file edits.');
  let bytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || (typeof item.content !== 'string' && item.content !== null)) throw new Error('Each edit needs a path and string content (or null to delete).');
    if (typeof item.content === 'string' && (item.content.includes('\0') || Buffer.from(item.content, 'utf8').toString('utf8') !== item.content)) throw new Error('Batch edits require valid UTF-8 text without NUL bytes.');
    bytes += Buffer.byteLength(item.content ?? '');
    if (bytes > 8 * 1024 * 1024) throw new Error('Batch content exceeds 8 MiB.');
    return { path: item.path, content: item.content };
  });
}

function checkedPath(root: string, path: string): string {
  const full = workspacePath(root, path);
  const parts = relative(root, full).split(sep);
  if (parts.some(p => ['.git', '.anvil', 'node_modules'].includes(p))) throw new Error('Batch edits cannot modify Git, Anvil state, or dependencies.');
  let parent = full;
  while (parent !== root) {
    try { if (lstatSync(parent).isSymbolicLink()) throw new Error(`Batch edits cannot replace symlinks: ${path}`); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    parent = dirname(parent);
  }
  return full;
}
function contentAt(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
  const data = readFileSync(path);
  if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) throw new Error('Batch edits support UTF-8 text files only.');
  return data.toString('utf8');
}
function persist(root: string, journal: Journal): void {
  const path = workspaceStatePath(root, 'transaction.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(journal), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function replace(root: string, entry: Entry, content: string | null, expected: string | null): void {
  const path = checkedPath(root, entry.path);
  if (contentAt(path) !== expected) throw new Error(`File changed during transaction: ${entry.path}`);
  if (content === null) { if (existsSync(path)) rmSync(path); }
  else commitContent(path, content, { content: expected ?? '', exists: expected !== null });
}
function restore(root: string, journal: Journal): void {
  const conflicts: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      const path = checkedPath(root, entry.path);
      const current = contentAt(path);
      if (current === entry.before) continue;
      if (current !== entry.after) throw new Error('Content changed outside the transaction');
      replace(root, entry, entry.before, entry.after);
      if (entry.before !== null) {
        // commitContent preserves current modes; restore the original mode for deleted files.
        chmodSync(path, entry.mode);
      }
    } catch { conflicts.push(entry.path); }
  }
  for (const dir of [...journal.createdDirs].reverse()) {
    try { rmdirSync(dirname(checkedPath(root, join(dir, '__placeholder')))); } catch { /* preserve nonempty directories */ }
  }
  if (conflicts.length) throw new Error(`Recovery conflict in ${conflicts.join(', ')}. Journal retained at ${workspaceStatePath(root, 'transaction.json')}.`);
  rmSync(workspaceStatePath(root, 'transaction.json'), { force: true });
}

function recoverLocked(root: string): void {
  const path = workspaceStatePath(root, 'transaction.json');
  if (!existsSync(path)) return;
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  if (journal.version !== 1 || journal.root !== root || !Array.isArray(journal.entries) || !Array.isArray(journal.createdDirs)) throw new Error('Invalid transaction journal; refusing recovery.');
  if (journal.state === 'committed') rmSync(path);
  else if (journal.state === 'applying') restore(root, journal);
  else throw new Error('Unknown transaction journal state.');
}
export function recoverTransaction(workdir: string): void {
  const root = realpathSync(workdir);
  const unlock = lockWorkspace(root, 'transaction');
  try { recoverLocked(root); } finally { unlock(); }
}

/** All selected edits validate together; ordinary apply failures roll back the entire batch. */
export async function applyTransaction(workdir: string, sessionId: string, input: unknown, options: TransactionOptions = {}): Promise<TransactionResult> {
  const root = realpathSync(workdir);
  const unlock = lockWorkspace(root, 'transaction');
  let stage: string | undefined;
  const id = randomUUID();
  try {
    recoverLocked(root);
    uiStream.throwIfCancelled();
    const edits = parseEdits(input);
    const unique = new Set<string>();
    const entries: Entry[] = edits.map(edit => {
      const path = checkedPath(root, edit.path);
      if (unique.has(path)) throw new Error(`Duplicate file in batch: ${edit.path}`);
      unique.add(path);
      const before = contentAt(path);
      if (edit.content === null && before === null) throw new Error(`Cannot delete missing file: ${edit.path}`);
      return { path: relative(root, path), before, after: edit.content, mode: before === null ? 0o644 : lstatSync(path).mode };
    }).filter(e => e.before !== e.after);
    if (!entries.length) return { status: 'applied', paths: [], id };
    const paths = entries.map(e => e.path);
    stage = mkdtempSync(join(tmpdir(), 'anvil-transaction-'));
    const snapshot = snapshotProject(root, stage);
    const stageEntries = () => {
      for (const e of entries) {
        const path = join(stage!, e.path);
        if (e.after === null) rmSync(path, { force: true });
        else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, e.after); }
      }
    };
    stageEntries();
    const validate = options.validate ?? validateCandidate;
    const initialErrors = await validate(stage, paths);
    uiStream.throwIfCancelled();
    if (initialErrors.length) throw new Error(`Batch validation failed:\n${initialErrors.join('\n')}`);
    let selectedChanged = false;
    for (const e of entries) {
      const diff = generateDiff(e.before ?? '', e.after ?? '', join(root, e.path));
      const metadataOnly = !diff.hunks.length;
      if (metadataOnly) diff.hunks.push({ header: e.after === null ? 'Delete empty file' : 'Create empty file', lines: [], oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 });
      const accepted = await uiStream.waitForDiffResolution(join(root, e.path), diff);
      uiStream.throwIfCancelled();
      if (!accepted.size) return { status: 'rejected', paths: [], id };
      if (e.after === null && accepted.size !== diff.hunks.length) throw new Error('A deletion must be approved in full. No files changed.');
      if (e.after !== null && !metadataOnly) {
        const selected = applySelectedHunks(e.before ?? '', diff.hunks, accepted);
        selectedChanged ||= selected !== e.after;
        e.after = selected;
      }
    }
    if (selectedChanged) {
      stageEntries();
      const errors = await validate(stage, paths);
      if (errors.length) throw new Error(`Selected batch validation failed:\n${errors.join('\n')}`);
    }
    uiStream.throwIfCancelled();
    if (snapshotProject(root).fingerprint !== snapshot.fingerprint) throw new Error('Workspace changed while the batch was being reviewed. Read it again and retry.');
    for (const e of entries) if (contentAt(checkedPath(root, e.path)) !== e.before) throw new Error(`File changed: ${e.path}`);
    const createdDirs: string[] = [];
    for (const e of entries.filter(e => e.after !== null)) {
      let dir = dirname(join(root, e.path));
      while (dir !== root && !existsSync(dir)) { createdDirs.push(relative(root, dir)); dir = dirname(dir); }
    }
    createdDirs.sort((a, b) => a.split(sep).length - b.split(sep).length);
    const journal: Journal = { version: 1, root, sessionId, id, entries, state: 'applying', createdDirs: [...new Set(createdDirs)] };
    persist(root, journal);
    try {
      entries.forEach((e, i) => { options.beforeApply?.(i); replace(root, e, e.after, e.before); });
      journal.state = 'committed'; persist(root, journal);
    } catch (err) {
      restore(root, journal);
      throw err;
    }
    rmSync(workspaceStatePath(root, 'transaction.json'));
    for (const e of entries) {
      const path = join(root, e.path);
      recordCommitted(sessionId, path, e.after ?? '');
      uiStream.push({ type: 'file_modified', path });
      uiStream.push({ type: 'file_diff', filepath: path, originalContent: e.before, newContent: e.after,
        diff: generateDiff(e.before ?? '', e.after ?? '', path), sessionId });
    }
    uiStream.push({ type: 'transaction_applied', transactionId: id, paths });
    return { status: 'applied', paths, id };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    unlock();
  }
}
