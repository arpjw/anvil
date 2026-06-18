import { readFileSync } from 'fs';
import { runPlanner, type Plan } from './planner.js';
import { runExecutor } from './executor.js';
import { uiStream } from '../ui/stream.js';

// ── Complexity heuristic ──────────────────────────────────────────────────────

const MULTI_FILE_KEYWORDS = [
  'refactor', 'rename', 'move', 'across', 'throughout', 'everywhere',
  'all files', 'multiple files', 'each file', 'every file',
];

function isComplex(request: string): boolean {
  const lower = request.toLowerCase();
  if (MULTI_FILE_KEYWORDS.some(kw => lower.includes(kw))) return true;
  const fileMentions = request.match(/\b[\w./][\w./]*\.(ts|js|py|json|md|css|html)\b/g) ?? [];
  return new Set(fileMentions).size >= 2;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runOrchestrator(
  request: string,
  workdir: string,
  sessionId: string,
): Promise<void> {
  // ── Simple path ──────────────────────────────────────────────────────────────
  if (!isComplex(request)) {
    const plan: Plan = {
      goal: request,
      context: 'Single-file request, planner skipped.',
      filesToModify: [],
      filesToCreate: [],
      steps: [request],
      verificationCriteria: [],
      risks: [],
    };

    uiStream.push({ type: 'phase', phase: 'executing' });
    const report = await runExecutor(plan, workdir, sessionId);
    reportEscalations(report.escalations);
    return;
  }

  // ── Complex path: planner → approval gate → executor ────────────────────────
  let feedback: string | undefined;
  let plan: Plan;

  for (;;) {
    // Promise.all scaffold kept for future concurrent exploration tasks.
    const [planPath] = await Promise.all([
      runPlanner(request, workdir, sessionId, feedback),
    ]);

    plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;
    uiStream.push({ type: 'plan_ready', plan });

    const response = await uiStream.waitForApproval();

    if (response.answer === 'y') break;

    if (response.answer === 'n') {
      uiStream.push({ type: 'done', summary: 'Plan rejected by user.' });
      return;
    }

    // answer === 'revise' — re-run planner with feedback
    feedback = response.feedback;
    uiStream.push({ type: 'phase', phase: 'planning' });
  }

  uiStream.push({ type: 'phase', phase: 'executing' });
  const report = await runExecutor(plan!, workdir, sessionId);
  reportEscalations(report.escalations);

  if (report.success) {
    uiStream.ensureDone('All steps completed successfully.');
  }
}

function reportEscalations(escalations: string[]): void {
  for (const e of escalations) {
    uiStream.push({ type: 'error', message: e });
  }
}
