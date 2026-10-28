import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, appendFileSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname, join, extname } from 'path';
import { randomUUID, createHash } from 'crypto';
import { getLspClient, type LspDiagnostic } from '../lsp/client.js';
import { generateDiff, applySelectedHunks } from '../diff/engine.js';
import { uiStream } from '../ui/stream.js';

export type { LspDiagnostic };

export interface ShadowResult {
  clean: boolean;
  diagnostics: LspDiagnostic[];
  finalContent: string;
  allRejected: boolean;
  validationError?: string;
}

interface ShadowValidator {
  checkContent(path: string, content: string): Promise<LspDiagnostic[]>;
  revertContent(path: string): Promise<void>;
}

const SHADOW_BASE = '/tmp/anvil';
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function shadowPath(sessionId: string, absFilePath: string): string {
  const stripped = absFilePath.startsWith('/') ? absFilePath.slice(1) : absFilePath;
  return join(SHADOW_BASE, sessionId, 'shadow', stripped);
}

function appendLog(sessionId: string, entry: Record<string, unknown>): void {
  const lp = join(SHADOW_BASE, sessionId, 'shadow.log');
  mkdirSync(dirname(lp), { recursive: true });
  appendFileSync(lp, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
}

export async function shadowWrite(
  sessionId: string,
  absFilePath: string,
  originalContent: string,
  newContent: string,
  workdir: string,
  validator?: ShadowValidator,
): Promise<ShadowResult> {
  const sp = shadowPath(sessionId, absFilePath);
  mkdirSync(dirname(sp), { recursive: true });
  writeFileSync(sp, newContent, 'utf-8');
  let lsp: ShadowValidator | undefined = validator;
  const fail = (diagnostics: LspDiagnostic[], validationError?: string): ShadowResult => {
    appendLog(sessionId, { file: absFilePath, outcome: 'rejected',
      diagnostics: diagnostics.map(d => `${d.line}:${d.character} ${d.message}`), validationError });
    return { clean: false, diagnostics, finalContent: originalContent, allRejected: false, validationError };
  };
  try {
    const ext = extname(absFilePath).toLowerCase();
    if (TS_EXTENSIONS.has(ext)) lsp ??= await getLspClient(workdir);
    const validate = async (content: string): Promise<LspDiagnostic[]> => {
      if (lsp) return (await lsp.checkContent(absFilePath, content)).filter(d => d.severity === 'error');
      if (ext === '.json') JSON.parse(content);
      return [];
    };
    let errors = await validate(newContent);
    if (errors.length) return fail(errors);

    const diff = generateDiff(originalContent, newContent, absFilePath);
    let finalContent = newContent;
    if (diff.hunks.length) {
      const accepted = await uiStream.waitForDiffResolution(absFilePath, diff);
      if (!accepted.size) {
        appendLog(sessionId, { file: absFilePath, outcome: 'user-rejected' });
        return { clean: true, diagnostics: [], finalContent: originalContent, allRejected: true };
      }
      finalContent = applySelectedHunks(originalContent, diff.hunks, accepted);
      // A subset of individually valid changes can break types or JSON syntax.
      if (finalContent !== newContent) {
        errors = await validate(finalContent);
        if (errors.length) return fail(errors);
      }
    }
    writeFileSync(sp, finalContent, 'utf-8');
    appendLog(sessionId, { file: absFilePath, outcome: 'validated',
      validation: lsp ? 'typescript-lsp' : ext === '.json' ? 'json-syntax' : 'deferred-to-project-checks' });
    return { clean: true, diagnostics: [], finalContent, allRejected: false };
  } catch (err) {
    return fail([], (err as Error).message);
  } finally {
    // Rejected proposals must never contaminate the next file's diagnostics.
    await lsp?.revertContent(absFilePath).catch(() => {});
  }
}

/** Atomic replacement with an optimistic check against edits made during review. */
export function commitContent(absFilePath: string, content: string, expected?: { content: string; exists: boolean }): void {
  if (expected) {
    const exists = existsSync(absFilePath);
    if (exists !== expected.exists || (exists && readFileSync(absFilePath, 'utf-8') !== expected.content)) {
      throw new Error('File changed while the diff was being reviewed. Read it again before retrying.');
    }
  }
  mkdirSync(dirname(absFilePath), { recursive: true });
  const tmp = join(dirname(absFilePath), `.anvil-${randomUUID()}.tmp`);
  try {
    const mode = existsSync(absFilePath) ? statSync(absFilePath).mode : 0o666;
    writeFileSync(tmp, content, { encoding: 'utf-8', mode, flag: 'wx' });
    renameSync(tmp, absFilePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function recordCommitted(sessionId: string, absFilePath: string, content: string): void {
  appendLog(sessionId, { file: absFilePath, outcome: 'committed',
    sha256: createHash('sha256').update(content).digest('hex') });
}

export async function commitToReal(sessionId: string, absFilePath: string): Promise<void> {
  const sp = shadowPath(sessionId, absFilePath);
  mkdirSync(dirname(absFilePath), { recursive: true });
  copyFileSync(sp, absFilePath);
}

export function clearSession(sessionId: string): void {
  const dir = join(SHADOW_BASE, sessionId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function formatDiagnostics(diags: LspDiagnostic[]): string {
  return diags.map(d => `  ${d.file}:${d.line}:${d.character}: ${d.message}`).join('\n');
}
