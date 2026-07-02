import OpenAI from 'openai';
import { runExecutor } from '../agents/executor.js';
import { uiStream } from '../ui/stream.js';
import type { Plan } from '../agents/planner.js';
import {
  validationEngine,
  type ValidationError,
  type ValidateOutput,
} from '../services/validation/index.js';

export interface VerificationResult {
  passed: boolean;
  rounds: number;
  remainingFailures: string[];
}

const MAX_ROUNDS = 2;

function formatFailure(e: ValidationError): string {
  const loc = e.file
    ? e.line > 0 ? `${e.file}:${e.line}` : e.file
    : '';
  const head = loc ? `[${e.phase}] ${loc}` : `[${e.phase}]`;
  return `${head} — ${e.message}`;
}

function formatFailures(result: ValidateOutput): string[] {
  const grouped: Record<string, ValidationError[]> = {};
  for (const e of result.errors) {
    (grouped[e.phase] ??= []).push(e);
  }
  const out: string[] = [];
  for (const phase of ['typecheck', 'lint', 'test', 'custom'] as const) {
    const list = grouped[phase] ?? [];
    if (list.length === 0) continue;
    out.push(`${phase.toUpperCase()} FAILURES (${list.length}):`);
    for (const e of list) out.push(`  ${formatFailure(e)}`);
  }
  return out;
}

export async function runVerification(
  workdir: string,
  sessionId: string,
  plan: Plan,
  ignorePatterns?: string[],
  client?: OpenAI,
  modelId?: string,
): Promise<VerificationResult> {
  uiStream.push({ type: 'verification_start' });

  await validationEngine.start();
  try {
    let result = await validationEngine.validate({ workdir, sessionId });

    if (result.passed) {
      uiStream.push({ type: 'verification_pass', rounds: 0 });
      return { passed: true, rounds: 0, remainingFailures: [] };
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const failureLines = formatFailures(result);
      const fixPlan = await validationEngine.planFix({
        workdir,
        errors: result.errors,
        sessionId,
      });

      const fixInstruction = [
        'Fix only the failures listed below. Do not make other changes.',
        '',
        ...failureLines,
        '',
        fixPlan.plan,
      ].join('\n');

      await runExecutor(plan, workdir, sessionId, ignorePatterns, fixInstruction, client, modelId);

      result = await validationEngine.validate({ workdir, sessionId });

      if (result.passed) {
        uiStream.push({ type: 'verification_pass', rounds: round });
        return { passed: true, rounds: round, remainingFailures: [] };
      }
    }

    const failureLines = formatFailures(result);
    uiStream.push({ type: 'verification_fail', failures: failureLines });
    return { passed: false, rounds: MAX_ROUNDS, remainingFailures: failureLines };
  } finally {
    await validationEngine.stop();
  }
}
