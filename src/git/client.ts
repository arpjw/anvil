import { simpleGit, type DefaultLogFields } from 'simple-git';
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import { workspacePath } from '../tools/workspace_path.js';

export interface GitContext {
  branch: string;
  recentCommits: Array<{ hash: string; message: string; date: string }>;
  stagedDiff: string;
  unstagedDiff: string;
}

export async function getGitContext(workdir: string): Promise<GitContext> {
  const git = simpleGit(workdir);
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  const log = await git.log({ maxCount: 10 });
  const stagedDiff = await git.diff(['--cached']);
  const unstagedDiff = await git.diff();
  return {
    branch,
    recentCommits: log.all.map((c: DefaultLogFields) => ({
      hash: c.hash.slice(0, 7),
      message: c.message,
      date: c.date.slice(0, 10),
    })),
    stagedDiff,
    unstagedDiff,
  };
}

export interface SessionMetadata {
  sessionId: string;
  originalBranch: string;
  branchName: string;
  baseCommit: string;
  createdAt: string;
}

export function getSessionMetadata(workdir: string, sessionId: string): SessionMetadata {
  if (!/^[a-zA-Z0-9-]{8,}$/.test(sessionId)) throw new Error('Invalid session id.');
  const path = join(workdir, '.anvil', `session-${sessionId.slice(0, 8)}.json`);
  const meta = JSON.parse(readFileSync(path, 'utf-8')) as SessionMetadata;
  if (!meta.sessionId.startsWith(sessionId) || !meta.branchName.startsWith('anvil/session-')) {
    throw new Error('Session metadata does not match the requested session.');
  }
  return meta;
}

export async function createSessionBranch(workdir: string, sessionId: string): Promise<string> {
  const git = simpleGit(workdir);
  const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  let previous: SessionMetadata | undefined;
  try { previous = getSessionMetadata(workdir, sessionId); } catch { /* new session */ }
  if (previous) {
    if (current !== previous.branchName) throw new Error(`Resume on ${previous.branchName}; current branch is ${current}.`);
    return previous.branchName;
  }
  const status = await git.status();
  if (status.files.some(f => f.index !== '?' && f.working_dir !== '?')) {
    throw new Error('Commit or stash tracked changes before starting an automatically branched session.');
  }
  const baseCommit = (await git.revparse(['HEAD'])).trim();
  const originalBranch = current === 'HEAD' ? baseCommit : current;
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branchName = `anvil/session-${sessionId.slice(0, 8)}-${dateStr}`;
  await git.checkoutLocalBranch(branchName);
  const metaDir = join(workdir, '.anvil');
  mkdirSync(metaDir, { recursive: true });
  const metaPath = join(metaDir, `session-${sessionId.slice(0, 8)}.json`);
  writeFileSync(metaPath, JSON.stringify({ sessionId, originalBranch, branchName, baseCommit,
    createdAt: new Date().toISOString() }, null, 2));
  await commitFile(workdir, metaPath, `chore: initialize anvil session ${sessionId.slice(0, 8)}`);
  return branchName;
}

export async function commitFile(workdir: string, filepath: string, message: string): Promise<string> {
  const git = simpleGit(workdir);
  const rel = relative(realpathSync(workdir), workspacePath(workdir, filepath));
  if ((await git.raw(['diff', '--cached', '--name-only', '--', rel])).trim() !== rel) {
    await git.raw(['add', '--', rel]);
  } else if ((await git.raw(['diff', '--name-only', '--', rel])).trim()) {
    await git.raw(['add', '--', rel]);
  }
  if (!(await git.raw(['diff', '--cached', '--name-only', '--', rel])).trim()) return '';
  // --only keeps unrelated staged changes out of the session commit.
  const result = await git.raw(['commit', '--only', '-m', message, '--', rel]);
  void result;
  return (await git.revparse(['HEAD'])).trim();
}

export async function rollbackSession(workdir: string, sessionId: string): Promise<string[]> {
  const git = simpleGit(workdir);
  const meta = getSessionMetadata(workdir, sessionId);
  const current = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  if (current !== meta.branchName) throw new Error(`Rollback must run on ${meta.branchName}.`);
  const status = await git.status();
  if (status.files.some(f => f.index !== '?' && f.working_dir !== '?')) {
    throw new Error('Rollback refused: uncommitted changes would be lost. Commit or stash them first.');
  }
  const base = meta.baseCommit || (await git.raw(['merge-base', meta.originalBranch, meta.branchName])).trim();
  const raw = await git.raw(['diff', '--name-only', '-z', base, meta.branchName]);
  const files = raw.split('\0').filter(f => f && !f.startsWith('.anvil/'));
  // Preserve the session branch as a recovery point. Checkout itself refuses
  // untracked-file collisions; there is no hard reset or forced branch delete.
  await git.checkout(meta.originalBranch);
  return files;
}

export async function generatePRDescription(sessionId: string, workdir: string): Promise<string> {
  const git = simpleGit(workdir);
  const shortId = sessionId.slice(0, 8);

  // Determine the base branch.
  let baseBranch: string;
  try {
    const meta = getSessionMetadata(workdir, sessionId);
    baseBranch = meta.baseCommit || meta.originalBranch;
  } catch {
    baseBranch = 'main';
    try { await git.revparse(['main']); } catch { baseBranch = 'master'; }
  }

  let commits: Array<{ hash: string; message: string; date: string; author_name: string }> = [];
  let changedFiles: string[] = [];

  try {
    const log = await git.log({ from: baseBranch, to: 'HEAD' });
    commits = log.all.map((c: DefaultLogFields) => ({
      hash: c.hash.slice(0, 7),
      message: c.message,
      date: c.date.slice(0, 10),
      author_name: c.author_name,
    }));
  } catch {}

  try {
    const diff = await git.diffSummary([baseBranch]);
    changedFiles = diff.files.map((f: { file: string }) => f.file);
  } catch {}

  const commitList = commits.length
    ? commits.map(c => `- \`${c.hash}\` ${c.message} (${c.date})`).join('\n')
    : '- (no commits found)';

  const fileList = changedFiles.length
    ? changedFiles.map(f => `- \`${f}\``).join('\n')
    : '- (none)';

  const pr = `# Anvil Session ${shortId}

## Summary

${commitList}

## Motivation

Automated changes produced by Anvil agent (session \`${shortId}\`).

## Files Changed

${fileList}

## Testing Notes

- Review each file change individually
- Run TypeScript compilation: \`tsc --noEmit\`
- Run tests if available: \`npm test\`
`;

  const outDir = join(workdir, '.anvil');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `pr-${shortId}.md`);
  writeFileSync(outPath, pr);
  return outPath;
}
