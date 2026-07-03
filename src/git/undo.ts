import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { relative, resolve } from 'path';
import { simpleGit } from 'simple-git';
import { appendMemory } from '../context/project.js';

function sessionBranchName(sessionId: string, date?: string): string {
  // Matches createSessionBranch(): anvil/session-<8chars>-<YYYYMMDD>
  const short = sessionId.slice(0, 8);
  if (date) return `anvil/session-${short}-${date}`;
  return `anvil/session-${short}-*`;
}

async function findSessionBranch(
  workdir: string,
  sessionId: string,
): Promise<string | null> {
  const git = simpleGit(workdir);
  const branches = await git.branch(['--list', `anvil/session-${sessionId.slice(0, 8)}-*`]);
  const match = Object.keys(branches.branches).find((b) =>
    b.startsWith(`anvil/session-${sessionId.slice(0, 8)}-`),
  );
  return match ?? null;
}

// List every file the session touched (added, modified, deleted).
export async function undoableFiles(
  workdir: string,
  sessionId: string,
): Promise<string[]> {
  const git = simpleGit(workdir);
  const branch = await findSessionBranch(workdir, sessionId);
  if (!branch) return [];
  // Compare the session branch tip against its merge-base with main —
  // that's every file the session actually changed.
  let base: string;
  try {
    base = (await git.raw(['merge-base', branch, 'main'])).trim();
  } catch {
    // no main branch — fall back to the parent of the branch's first commit
    base = (await git.raw(['rev-list', '--max-parents=0', branch])).trim();
  }
  const raw = await git.raw(['diff', '--name-only', `${base}..${branch}`]);
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Restore the pre-session content of one file. For files that were CREATED
// by the session (no pre-session content), delete them.
export async function undoFile(
  workdir: string,
  filepath: string,
  sessionId: string,
): Promise<{ deleted: boolean; commitHash: string }> {
  const git = simpleGit(workdir);
  const branch = await findSessionBranch(workdir, sessionId);
  if (!branch) throw new Error(`No session branch found for ${sessionId.slice(0, 8)}`);

  const absPath = resolve(workdir, filepath);
  const rel = relative(workdir, absPath);

  // Find the merge-base with main. That's the "before session" state.
  let base: string;
  try {
    base = (await git.raw(['merge-base', branch, 'main'])).trim();
  } catch {
    base = (await git.raw(['rev-list', '--max-parents=0', branch])).trim();
  }

  // Ask git whether the file existed at `base`. If it did, restore its content;
  // if not, the session created it — delete the file.
  let preContent: string | null = null;
  try {
    preContent = await git.raw(['show', `${base}:${rel}`]);
  } catch {
    preContent = null; // file didn't exist in the pre-session tree
  }

  let deleted = false;
  if (preContent === null) {
    if (existsSync(absPath)) unlinkSync(absPath);
    deleted = true;
  } else {
    writeFileSync(absPath, preContent, 'utf-8');
  }

  const msg = deleted
    ? `revert: remove ${rel} (created by session ${sessionId.slice(0, 8)})`
    : `revert: undo ${rel} from session ${sessionId.slice(0, 8)}`;

  await git.add([absPath]).catch(async () => {
    // For deletes, `git add` on a missing path errors — use --all to record removal.
    await git.raw(['add', '--all', rel]);
  });
  const commit = await git.commit(msg, ['--allow-empty']);
  const hash = commit.commit;

  try {
    appendMemory(workdir, sessionId, `Undid changes to ${rel} from session ${sessionId.slice(0, 8)}`);
  } catch { /* non-fatal */ }

  // Silence linter for the alias helper that other modules may want later.
  void sessionBranchName;

  return { deleted, commitHash: hash };
}
