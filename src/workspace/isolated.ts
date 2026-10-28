import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import { execa } from 'execa';

export interface IsolatedWorkspace {
  sessionId: string;
  sourceWorkdir: string;
  workdir: string;
  branchName: string;
  baseCommit: string;
}

/** A Git checkout boundary, not an OS security sandbox. Never checks out the source. */
export async function prepareWorkspace(source: string, sessionId: string): Promise<IsolatedWorkspace> {
  if (!/^[a-zA-Z0-9-]{8,}$/.test(sessionId)) throw new Error('Invalid session id.');
  const sourceWorkdir = realpathSync(source);
  const git = simpleGit(sourceWorkdir);
  let top: string;
  try { top = realpathSync((await git.revparse(['--show-toplevel'])).trim()); }
  catch { throw new Error('Isolated execution requires a Git repository. Use --no-isolate explicitly for an in-place run.'); }
  if (top !== sourceWorkdir) throw new Error('Start isolated execution from the repository root.');
  const common = resolve(sourceWorkdir, (await git.revparse(['--git-common-dir'])).trim());
  const storage = join(common, 'anvil');
  const metadata = join(storage, 'sessions', `${sessionId}.json`);
  if (existsSync(metadata)) {
    const saved = JSON.parse(readFileSync(metadata, 'utf8')) as IsolatedWorkspace;
    if (saved.sourceWorkdir !== sourceWorkdir || !existsSync(saved.workdir)) throw new Error('Session workspace is unavailable or belongs to another checkout.');
    const actual = simpleGit(saved.workdir);
    if ((await actual.revparse(['--abbrev-ref', 'HEAD'])).trim() !== saved.branchName ||
        resolve(saved.workdir, (await actual.revparse(['--git-common-dir'])).trim()) !== common) {
      throw new Error('Session workspace Git identity changed.');
    }
    return saved;
  }
  if ((await git.status()).files.some(f => f.index !== '?' && f.working_dir !== '?')) {
    throw new Error('Commit or stash tracked changes before an isolated run. Your checkout was not modified.');
  }
  const baseCommit = (await git.revparse(['HEAD'])).trim();
  const branchName = `anvil/session-${sessionId.slice(0, 8)}-${sessionId.slice(8) || 'worktree'}`;
  const workdir = join(storage, 'worktrees', sessionId);
  mkdirSync(join(storage, 'sessions'), { recursive: true });
  mkdirSync(join(storage, 'worktrees'), { recursive: true });
  await execa('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branchName, workdir, baseCommit], { cwd: sourceWorkdir });
  const saved: IsolatedWorkspace = { sessionId, sourceWorkdir, workdir: realpathSync(workdir), branchName, baseCommit };
  if (existsSync(join(saved.workdir, '.anvil')) && lstatSync(join(saved.workdir, '.anvil')).isSymbolicLink()) throw new Error('Project .anvil directory must not be a symlink.');
  mkdirSync(join(saved.workdir, '.anvil'), { recursive: true });
  // Copy local guidance, never alias writable dependency trees or credentials.
  for (const name of ['rules.md', 'ignore', 'memory.md']) {
    const path = join(sourceWorkdir, '.anvil', name);
    if (existsSync(path) && !lstatSync(join(sourceWorkdir, '.anvil')).isSymbolicLink() && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      if (lstatSync(path).size > 1024 * 1024) throw new Error(`Project guidance is too large: ${name}`);
      copyFileSync(path, join(saved.workdir, '.anvil', name));
    }
  }
  writeFileSync(join(saved.workdir, '.anvil', `session-${sessionId.slice(0, 8)}.json`), JSON.stringify({ ...saved, originalBranch: baseCommit, createdAt: new Date().toISOString() }, null, 2));
  writeFileSync(metadata, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
  return saved;
}

export async function changedWorkspaceFiles(workdir: string): Promise<string[]> {
  const git = simpleGit(workdir);
  const tracked = await git.raw(['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
  const untracked = await git.raw(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set((tracked + untracked).split('\0').filter(Boolean))]
    .filter(path => !path.startsWith('.anvil/') && path !== '.anvil');
}

/** Keep each verified multi-file result together in one Git commit. */
export async function commitWorkspace(workdir: string, sessionId: string): Promise<string> {
  const paths = await changedWorkspaceFiles(workdir);
  if (!paths.length) return '';
  const git = simpleGit(workdir);
  await git.raw(['add', '-A', '--', ...paths]);
  await execa('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--only', '-m', `feat: anvil session ${sessionId.slice(0, 8)}`, '--', ...paths], { cwd: workdir });
  return (await git.revparse(['HEAD'])).trim();
}
