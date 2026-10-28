import { relative } from 'path';
import { realpathSync } from 'fs';
import { simpleGit } from 'simple-git';
import { getSessionMetadata, commitFile } from './client.js';
import { workspacePath } from '../tools/workspace_path.js';

export async function undoableFiles(workdir: string, sessionId: string): Promise<string[]> {
  const git = simpleGit(workdir);
  const meta = getSessionMetadata(workdir, sessionId);
  const base = meta.baseCommit || (await git.raw(['merge-base', meta.originalBranch, meta.branchName])).trim();
  const raw = await git.raw(['diff', '--name-only', '-z', base, meta.branchName]);
  return raw.split('\0').filter(f => f && !f.startsWith('.anvil/'));
}

export async function undoFile(workdir: string, filepath: string, sessionId: string): Promise<{ deleted: boolean; commitHash: string }> {
  const git = simpleGit(workdir);
  const meta = getSessionMetadata(workdir, sessionId);
  if ((await git.revparse(['--abbrev-ref', 'HEAD'])).trim() !== meta.branchName) {
    throw new Error(`Undo must run on ${meta.branchName}.`);
  }
  const rel = relative(realpathSync(workdir), workspacePath(workdir, filepath));
  if (!(await undoableFiles(workdir, sessionId)).includes(rel)) throw new Error('File was not changed by this session.');
  if ((await git.status()).files.some(f => f.path === rel)) throw new Error('File has uncommitted changes. Commit or stash them before undoing.');
  const base = meta.baseCommit || (await git.raw(['merge-base', meta.originalBranch, meta.branchName])).trim();
  let deleted = false;
  try { await git.raw(['cat-file', '-e', `${base}:${rel}`]); } catch { deleted = true; }
  if (deleted) await git.raw(['rm', '--', rel]);
  else await git.raw(['restore', `--source=${base}`, '--worktree', '--', rel]);
  const commitHash = await commitFile(workdir, rel, `revert: undo ${rel} from session ${sessionId.slice(0, 8)}`);
  return { deleted, commitHash };
}
