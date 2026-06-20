import OpenAI from 'openai';
import { existsSync } from 'fs';
import { join } from 'path';
import { runCommand } from '../tools/run_command.js';
import { runTests, type RunTestsResult } from '../tools/run_tests.js';
import { runExecutor } from '../agents/executor.js';
import { uiStream } from '../ui/stream.js';
import type { Plan } from '../agents/planner.js';

export interface VerificationResult {
  passed: boolean;
  rounds: number;
  remainingFailures: string[];
}

async function runTypeCheck(workdir: string): Promise<{ passed: boolean; errors: string[] }> {
  if (existsSync(join(workdir, 'tsconfig.json'))) {
    const result = await runCommand('npx tsc --noEmit', workdir, 60);
    if (result.exitCode === 0) return { passed: true, errors: [] };
    const errors = (result.stdout + '\n' + result.stderr)
      .split('\n')
      .filter(l => l.trim() && l.includes('error TS'))
      .slice(0, 30);
    return { passed: false, errors };
  }
  if (existsSync(join(workdir, 'pyproject.toml'))) {
    const result = await runCommand('python -m mypy .', workdir, 60);
    if (result.exitCode === 0) return { passed: true, errors: [] };
    const errors = (result.stdout + '\n' + result.stderr)
      .split('\n')
      .filter(l => l.trim() && (l.includes('error:') || l.includes('Found')))
      .slice(0, 30);
    return { passed: false, errors };
  }
  if (existsSync(join(workdir, 'Cargo.toml'))) {
    const result = await runCommand('cargo check', workdir, 60);
    if (result.exitCode === 0) return { passed: true, errors: [] };
    const errors = (result.stdout + '\n' + result.stderr)
      .split('\n')
      .filter(l => l.trim() && l.startsWith('error'))
      .slice(0, 30);
    return { passed: false, errors };
  }
  return { passed: true, errors: [] };
}

function buildFailures(typeErrors: string[], testResult: RunTestsResult): string[] {
  const failures: string[] = [];

  if (typeErrors.length > 0) {
    failures.push('TYPE CHECK FAILURES:');
    failures.push(...typeErrors);
  }

  if (!testResult.passed) {
    failures.push('TEST FAILURES:');
    if (testResult.failingTests.length > 0) {
      for (const t of testResult.failingTests) {
        failures.push(`  - ${t.name}${t.file ? ` (${t.file})` : ''}${t.error ? `: ${t.error}` : ''}`);
      }
    } else {
      // No parsed failing tests — include raw tail
      const tail = testResult.rawOutput.slice(-800);
      failures.push(tail || '(no output)');
    }
  }

  return failures;
}

async function check(workdir: string): Promise<{ passed: boolean; failures: string[] }> {
  const typeResult = await runTypeCheck(workdir);
  const testResult = await runTests(workdir);

  if (typeResult.passed && testResult.passed) {
    return { passed: true, failures: [] };
  }

  return { passed: false, failures: buildFailures(typeResult.errors, testResult) };
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

  let { passed, failures } = await check(workdir);

  if (passed) {
    uiStream.push({ type: 'verification_pass', rounds: 0 });
    return { passed: true, rounds: 0, remainingFailures: [] };
  }

  for (let round = 1; round <= 2; round++) {
    const fixInstruction = [
      'Fix only the failures listed below. Do not make other changes.',
      '',
      ...failures,
    ].join('\n');

    await runExecutor(plan, workdir, sessionId, ignorePatterns, fixInstruction, client, modelId);

    ({ passed, failures } = await check(workdir));

    if (passed) {
      uiStream.push({ type: 'verification_pass', rounds: round });
      return { passed: true, rounds: round, remainingFailures: [] };
    }
  }

  uiStream.push({ type: 'verification_fail', failures });
  return { passed: false, rounds: 2, remainingFailures: failures };
}
