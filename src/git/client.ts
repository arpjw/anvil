import { simpleGit, type DefaultLogFields } from 'simple-git';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

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

export async function createSessionBranch(workdir: string, sessionId: string): Promise<string> {
  const git = simpleGit(workdir);
  const originalBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branchName = `anvil/session-${sessionId.slice(0, 8)}-${dateStr}`;

  await git.checkoutLocalBranch(branchName);

  // Store session metadata so rollback can find the original branch.
  const metaDir = join(workdir, '.anvil');
  mkdirSync(metaDir, { recursive: true });
  const metaPath = join(metaDir, `session-${sessionId.slice(0, 8)}.json`);
  writeFileSync(
    metaPath,
    JSON.stringify({ sessionId, originalBranch, branchName, createdAt: new Date().toISOString() }, null, 2),
  );

  // Commit the metadata file as the first commit on the session branch.
  await git.add(metaPath);
  await git.commit(`chore: initialize anvil session ${sessionId.slice(0, 8)}`);

  return branchName;
}

export async function commitFile(workdir: string, filepath: string, message: string): Promise<string> {
  const git = simpleGit(workdir);
  await git.add(filepath);
  const result = await git.commit(message, { '--allow-empty': null });
  return result.commit;
}

export async function rollbackSession(workdir: string, sessionId: string): Promise<string[]> {
  const git = simpleGit(workdir);
  const shortId = sessionId.slice(0, 8);
  const metaPath = join(workdir, '.anvil', `session-${shortId}.json`);

  let meta: { originalBranch: string; branchName: string };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    throw new Error(`No session metadata found for session ${shortId}. Expected at ${metaPath}`);
  }

  const { originalBranch, branchName } = meta;

  // Collect files changed in the session branch before reverting.
  let filesRestored: string[] = [];
  try {
    const diffSummary = await git.diffSummary([`${originalBranch}...${branchName}`]);
    filesRestored = diffSummary.files.map((f: { file: string }) => f.file);
  } catch {
    // Not fatal — diff may fail if the session branch has no unique commits.
  }

  const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

  if (currentBranch === branchName) {
    // Hard-reset the session branch back to the merge-base with the original branch.
    // This restores the working tree to the pre-session state before we checkout out.
    try {
      const mergeBase = (await git.raw(['merge-base', originalBranch, 'HEAD'])).trim();
      if (mergeBase) await git.reset(['--hard', mergeBase]);
    } catch {}
    await git.checkout(originalBranch);
  }

  // Delete the session branch (force — it is intentionally unmerged).
  await git.deleteLocalBranch(branchName, true);

  return filesRestored;
}

export async function generatePRDescription(sessionId: string, workdir: string): Promise<string> {
  const git = simpleGit(workdir);
  const shortId = sessionId.slice(0, 8);

  // Determine the base branch.
  let baseBranch = 'main';
  try { await git.revparse(['main']); }
  catch { try { await git.revparse(['master']); baseBranch = 'master'; } catch {} }

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
