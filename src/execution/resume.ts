import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { runOrchestrator, type OrchestratorOptions } from '../agents/orchestrator.js';
import type { Plan } from '../agents/planner.js';
import type { SessionResult } from '../session/result.js';

export async function resumeSession(sessionId: string, workdir: string, options: OrchestratorOptions = {}): Promise<SessionResult> {
  if (!/^[a-zA-Z0-9-]{8,}$/.test(sessionId)) throw new Error('Invalid session id.');
  const dir = join('/tmp/anvil', sessionId);
  let saved: { workdir: string; request: string; modelId: string; isolation?: 'worktree' | 'none' };
  let plan: Plan;
  try {
    saved = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8'));
    plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf-8'));
  } catch { throw new Error('No workspace-bound recovery plan found for this session.'); }
  if (resolve(saved.workdir) !== resolve(workdir)) throw new Error(`Session belongs to ${saved.workdir}, not ${workdir}.`);
  // File completion cannot be inferred from old log lines: a file can have
  // several plan steps, and its contents may have changed since the last run.
  return runOrchestrator(saved.request, workdir, sessionId, {
    ...options, isolation: saved.isolation ?? 'none', modelId: options.modelId ?? saved.modelId, resumePlan: plan,
  });
}
