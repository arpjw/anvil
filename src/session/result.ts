import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface SessionResult {
  sessionId: string;
  workdir: string;
  sourceWorkdir?: string;
  isolation?: 'worktree' | 'none';
  baseCommit?: string;
  commitHash?: string;
  request: string;
  modelId: string;
  status: 'complete' | 'failed' | 'aborted';
  summary: string;
  verification: 'passed' | 'failed' | 'skipped';
  failures: string[];
  filesModified: string[];
  branchName: string;
  startedAt: string;
  completedAt: string;
}

export function persistSessionResult(workdir: string, result: SessionResult): void {
  const dir = join(workdir, '.anvil', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.sessionId}.result.json`);
  writeFileSync(path + '.tmp', JSON.stringify(result, null, 2), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function readSessionResults(workdir: string): SessionResult[] {
  const dir = join(workdir, '.anvil', 'sessions');
  try {
    return readdirSync(dir).filter(f => f.endsWith('.result.json')).flatMap(file => {
      try {
        const result = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as SessionResult;
        return typeof result.sessionId === 'string' && ['complete', 'failed', 'aborted'].includes(result.status) ? [result] : [];
      } catch { return []; }
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch { return []; }
}
