import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { runExecutor } from '../agents/executor.js';
import { uiStream } from '../ui/stream.js';
import { registerInterruptHandler } from './interrupt.js';
import type { Plan } from '../agents/planner.js';

const SHADOW_BASE = '/tmp/anvil';

export async function resumeSession(sessionId: string, workdir: string): Promise<void> {
  const planPath = join(SHADOW_BASE, sessionId, 'plan.json');

  if (!existsSync(planPath)) {
    throw new Error(`Session ${sessionId} not found — plan.json missing at ${planPath}`);
  }

  const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;

  // Determine which files were already committed by reading shadow.log
  const logPath = join(SHADOW_BASE, sessionId, 'shadow.log');
  const committedFiles = new Set<string>();

  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.outcome === 'committed' && typeof entry.file === 'string') {
          committedFiles.add(entry.file);
        }
      } catch { /* malformed log line */ }
    }
  }

  // Reconstruct remaining plan: filter out already-committed files
  const remainingModify = plan.filesToModify.filter(
    f => !committedFiles.has(resolve(workdir, f)),
  );
  const remainingCreate = plan.filesToCreate.filter(
    f => !committedFiles.has(resolve(workdir, f)),
  );

  const remainingSteps = plan.steps.filter(step => {
    // Keep steps that don't mention already-committed files (best-effort heuristic)
    const absCommitted = [...committedFiles].map(f => f.replace(workdir + '/', ''));
    return !absCommitted.some(f => step.includes(f));
  });

  const remainingPlan: Plan = {
    ...plan,
    filesToModify: remainingModify,
    filesToCreate: remainingCreate,
    steps: remainingSteps.length > 0 ? remainingSteps : plan.steps,
  };

  registerInterruptHandler(sessionId, workdir);

  uiStream.push({ type: 'session_resumed', sessionId, plan: remainingPlan });
  uiStream.push({ type: 'phase', phase: 'executing' });

  const skipped = committedFiles.size;
  const remaining = remainingModify.length + remainingCreate.length;

  const extraContext = skipped > 0
    ? `Resuming session ${sessionId.slice(0, 8)}. ${skipped} file(s) already committed. ${remaining} file(s) remaining.`
    : undefined;

  await runExecutor(remainingPlan, workdir, sessionId, undefined, extraContext);
  uiStream.ensureDone('Session resumed and completed.');
}
