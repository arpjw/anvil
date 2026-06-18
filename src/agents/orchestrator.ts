import { readFileSync } from 'fs';
import * as readline from 'readline';
import { runPlanner, type Plan } from './planner.js';
import { runExecutor } from './executor.js';

// ── Complexity heuristic ──────────────────────────────────────────────────────

const MULTI_FILE_KEYWORDS = [
  'refactor', 'rename', 'move', 'across', 'throughout', 'everywhere',
  'all files', 'multiple files', 'each file', 'every file',
];

function isComplex(request: string): boolean {
  const lower = request.toLowerCase();
  if (MULTI_FILE_KEYWORDS.some(kw => lower.includes(kw))) return true;

  // Two or more distinct file paths mentioned → likely multi-file
  const fileMentions = request.match(/\b[\w./][\w./]*\.(ts|js|py|json|md|css|html)\b/g) ?? [];
  return new Set(fileMentions).size >= 2;
}

// ── Plan display ──────────────────────────────────────────────────────────────

function printPlan(plan: Plan): void {
  process.stdout.write('\n━━━ PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(`Goal: ${plan.goal}\n\n`);
  process.stdout.write(`Context:\n${plan.context}\n\n`);

  if (plan.filesToModify.length) {
    process.stdout.write(
      `Files to modify:\n${plan.filesToModify.map(f => `  • ${f}`).join('\n')}\n\n`,
    );
  }
  if (plan.filesToCreate.length) {
    process.stdout.write(
      `Files to create:\n${plan.filesToCreate.map(f => `  • ${f}`).join('\n')}\n\n`,
    );
  }

  process.stdout.write(
    `Steps:\n${plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n`,
  );

  if (plan.verificationCriteria.length) {
    process.stdout.write(
      `Verification:\n${plan.verificationCriteria.map(v => `  ✓ ${v}`).join('\n')}\n\n`,
    );
  }
  if (plan.risks.length) {
    process.stdout.write(
      `Risks:\n${plan.risks.map(r => `  ⚠ ${r}`).join('\n')}\n\n`,
    );
  }

  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// ── User prompt ───────────────────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runOrchestrator(
  request: string,
  workdir: string,
  sessionId: string,
): Promise<void> {
  // ── Simple path: single-file request ────────────────────────────────────────
  if (!isComplex(request)) {
    process.stderr.write('[Orchestrator] Simple request — routing direct to executor\n');

    // Auto-generate a minimal plan; empty filesToModify means no read restriction.
    const plan: Plan = {
      goal: request,
      context: 'Single-file request, planner skipped.',
      filesToModify: [],
      filesToCreate: [],
      steps: [request],
      verificationCriteria: [],
      risks: [],
    };

    const report = await runExecutor(plan, workdir, sessionId);
    reportEscalations(report.escalations);
    return;
  }

  // ── Complex path: spawn planner → approval gate → executor ──────────────────
  process.stderr.write('[Orchestrator] Complex request — spawning planner\n');

  let feedback: string | undefined;
  let plan: Plan;

  // Revision loop: planner → display → user decision
  for (;;) {
    // For independent sub-explorations, additional concurrent tasks can be
    // added alongside runPlanner: Promise.all([runPlanner(...), otherQuery(...)]).
    const [planPath] = await Promise.all([
      runPlanner(request, workdir, sessionId, feedback),
    ]);

    plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Plan;
    printPlan(plan);

    const answer = (await prompt('Approve plan? (y/n/revise): ')).toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      break;
    } else if (answer === 'n' || answer === 'no') {
      process.stdout.write('Plan rejected. Aborting.\n');
      return;
    } else if (answer === 'revise' || answer === 'r') {
      feedback = await prompt('Revision feedback for planner: ');
      process.stderr.write('[Orchestrator] Re-spawning planner with feedback...\n');
    } else {
      process.stdout.write('Please type y, n, or revise.\n');
    }
  }

  process.stderr.write('[Orchestrator] Plan approved — spawning executor\n');

  const report = await runExecutor(plan, workdir, sessionId);
  reportEscalations(report.escalations);

  if (report.success) {
    process.stderr.write('[Orchestrator] All steps completed successfully.\n');
  }
}

function reportEscalations(escalations: string[]): void {
  if (escalations.length === 0) return;
  process.stderr.write('\n[Orchestrator] Executor escalations (manual intervention required):\n');
  for (const e of escalations) {
    process.stderr.write(`  ${e}\n`);
  }
}
