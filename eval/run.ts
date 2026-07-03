import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { execa } from 'execa';
import { simpleGit } from 'simple-git';
import { runHeadless } from '../src/execution/headless.js';
import type { SWETask } from './swe_bench.js';

export interface EvalResult {
  instanceId: string;
  resolved: boolean;
  filesModified: string[];
  durationSeconds: number;
  costUSD?: number;
  passed: string[];
  failed: string[];
  error?: string;
  sessionId?: string;
  attemptedAt: string;
}

export interface RunOptions {
  outputDir: string;
  modelId: string;
  concurrency: number;
  resume: boolean;
  workRoot?: string; // where per-task clones go; default /tmp/anvil-eval
}

const DEFAULT_WORK_ROOT = '/tmp/anvil-eval';

// ── Public entrypoint ────────────────────────────────────────────────────────

export async function runEval(
  tasks: SWETask[],
  options: RunOptions,
): Promise<EvalResult[]> {
  mkdirSync(options.outputDir, { recursive: true });
  const workRoot = options.workRoot ?? DEFAULT_WORK_ROOT;
  mkdirSync(workRoot, { recursive: true });

  const results: EvalResult[] = new Array(tasks.length);

  for (let i = 0; i < tasks.length; i += options.concurrency) {
    const batch = tasks.slice(i, i + options.concurrency);
    const batchResults = await Promise.all(
      batch.map((task, j) =>
        runOne(task, options, workRoot).then((r) => {
          const idx = i + j;
          results[idx] = r;
          // Persist per-task so a crash doesn't lose completed work.
          writeFileSync(
            join(options.outputDir, `${sanitizeId(r.instanceId)}.json`),
            JSON.stringify(r, null, 2),
            'utf-8',
          );
          return r;
        }),
      ),
    );
    for (const r of batchResults) {
      const label = r.resolved ? '✓' : '✗';
      console.log(
        `[eval] ${label} ${r.instanceId}  ` +
          `passed=${r.passed.length}  failed=${r.failed.length}  ` +
          `dur=${r.durationSeconds}s` +
          (r.costUSD !== undefined ? `  cost=$${r.costUSD.toFixed(2)}` : ''),
      );
    }
  }

  return results.filter(Boolean);
}

// ── Single-task pipeline ─────────────────────────────────────────────────────

async function runOne(
  task: SWETask,
  options: RunOptions,
  workRoot: string,
): Promise<EvalResult> {
  const start = Date.now();
  const attemptedAt = new Date().toISOString();
  const outPath = join(options.outputDir, `${sanitizeId(task.instanceId)}.json`);

  if (options.resume && existsSync(outPath)) {
    try {
      const cached = JSON.parse(readFileSync(outPath, 'utf-8')) as EvalResult;
      console.log(`[eval] resume: skipping ${task.instanceId} (already scored)`);
      return cached;
    } catch { /* corrupted; re-run */ }
  }

  const workdir = join(workRoot, sanitizeId(task.instanceId));

  let result: EvalResult = {
    instanceId: task.instanceId,
    resolved: false,
    filesModified: [],
    durationSeconds: 0,
    passed: [],
    failed: [],
    attemptedAt,
  };

  try {
    await prepareRepo(task, workdir);
    await applyTestPatch(task, workdir);

    const anvilRun = await runAnvilAgainst(task, workdir, options.modelId);
    result.sessionId = anvilRun.sessionId;
    result.filesModified = anvilRun.filesModified;
    if (!anvilRun.success) {
      result.error = anvilRun.error ?? 'anvil did not complete';
    }

    const test = await runRelevantTests(task, workdir);
    result.passed = test.passed;
    result.failed = test.failed;

    // Resolved iff every FAIL_TO_PASS now passes AND every PASS_TO_PASS still passes.
    const failToPassOk = task.failToPass.every((t) => test.passed.includes(t));
    const passToPassOk = task.passToPass.every((t) => test.passed.includes(t));
    result.resolved = failToPassOk && passToPassOk;

    result.costUSD = readPersistedCost(workdir, anvilRun.sessionId);
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    result.durationSeconds = Math.round((Date.now() - start) / 1000);
    // Best-effort cleanup so a 50-task run doesn't fill /tmp.
    try { await fs.rm(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return result;
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function prepareRepo(task: SWETask, workdir: string): Promise<void> {
  // Fresh clone every time to guarantee a clean baseline.
  await fs.rm(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  await execa('git', ['clone', '--quiet', task.repoUrl, workdir], {
    stdio: 'inherit',
  });
  const git = simpleGit(workdir);
  await git.checkout(task.baseCommit);
}

async function applyTestPatch(task: SWETask, workdir: string): Promise<void> {
  if (!task.testPatch) return;
  // Use --allow-empty in case the patch touches nothing (some edge cases).
  const patchPath = join(workdir, '__anvil_test_patch.diff');
  writeFileSync(patchPath, task.testPatch, 'utf-8');
  const res = await execa('git', ['apply', '--verbose', '__anvil_test_patch.diff'], {
    cwd: workdir,
    reject: false,
  });
  await fs.unlink(patchPath).catch(() => {});
  if (res.exitCode !== 0) {
    throw new Error(
      `failed to apply test patch: exit ${res.exitCode}. ` +
        `stderr: ${(res.stderr ?? '').slice(0, 500)}`,
    );
  }
}

async function runAnvilAgainst(
  task: SWETask,
  workdir: string,
  modelId: string,
): Promise<{
  success: boolean;
  filesModified: string[];
  sessionId: string;
  error?: string;
}> {
  try {
    const res = await runHeadless(
      task.problemStatement,
      workdir,
      // noVerify=true — SWE-bench tasks generally can't self-verify without
      // the right Python env, and we're about to run the real tests anyway.
      true,
      undefined,
      modelId,
    );
    return {
      success: res.success,
      filesModified: res.filesModified,
      sessionId: res.sessionId,
    };
  } catch (err) {
    return {
      success: false,
      filesModified: [],
      sessionId: '',
      error: (err as Error).message,
    };
  }
}

interface TestOutcome {
  passed: string[];
  failed: string[];
}

async function runRelevantTests(
  task: SWETask,
  workdir: string,
): Promise<TestOutcome> {
  const runner = detectRunner(workdir);
  const testIds = [...task.failToPass, ...task.passToPass];
  if (testIds.length === 0) return { passed: [], failed: [] };

  switch (runner) {
    case 'pytest':
      return runPytest(workdir, testIds);
    case 'npm':
      return runNpm(workdir, testIds);
    default:
      // Unknown test runner — pretend every test failed so the task is scored
      // as unresolved rather than falsely passed.
      return { passed: [], failed: testIds };
  }
}

function detectRunner(workdir: string): 'pytest' | 'npm' | null {
  if (existsSync(join(workdir, 'pytest.ini'))) return 'pytest';
  if (existsSync(join(workdir, 'pyproject.toml'))) return 'pytest';
  if (existsSync(join(workdir, 'setup.cfg'))) return 'pytest';
  if (existsSync(join(workdir, 'setup.py'))) return 'pytest';
  if (existsSync(join(workdir, 'package.json'))) return 'npm';
  return null;
}

async function runPytest(
  workdir: string,
  testIds: string[],
): Promise<TestOutcome> {
  const args = ['-m', 'pytest', '--tb=short', '-q', ...testIds];
  const res = await execa('python', args, {
    cwd: workdir,
    reject: false,
    all: true,
    timeout: 5 * 60 * 1000,
  });
  return parsePytestOutput(res.stdout + '\n' + res.stderr, testIds);
}

function parsePytestOutput(output: string, testIds: string[]): TestOutcome {
  const passed: string[] = [];
  const failed: string[] = [];
  // Look for "PASSED" / "FAILED" markers per test ID.
  for (const id of testIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${escaped}[^\\n]*PASSED`, 'i').test(output)) {
      passed.push(id);
    } else if (new RegExp(`${escaped}[^\\n]*FAILED`, 'i').test(output)) {
      failed.push(id);
    } else {
      // Not mentioned in output → count as failed to be conservative.
      failed.push(id);
    }
  }
  return { passed, failed };
}

async function runNpm(
  workdir: string,
  testIds: string[],
): Promise<TestOutcome> {
  const res = await execa('npm', ['test', '--', ...testIds], {
    cwd: workdir,
    reject: false,
    all: true,
    timeout: 5 * 60 * 1000,
  });
  const out = res.stdout + '\n' + res.stderr;
  const passed: string[] = [];
  const failed: string[] = [];
  for (const id of testIds) {
    if (out.includes(id) && res.exitCode === 0) passed.push(id);
    else failed.push(id);
  }
  return { passed, failed };
}

// ── Cost extraction ──────────────────────────────────────────────────────────

function readPersistedCost(workdir: string, sessionId: string): number | undefined {
  if (!sessionId) return undefined;
  const dir = join(workdir, '.anvil', 'sessions');
  if (!existsSync(dir)) return undefined;
  try {
    const files = readFilesInDir(dir);
    const short = sessionId.slice(0, 8);
    const match = files.find(
      (f) =>
        f.endsWith('.json') && (f.startsWith(sessionId) || f.startsWith(short)),
    );
    if (!match) return undefined;
    const parsed = JSON.parse(readFileSync(join(dir, match), 'utf-8')) as {
      estimatedCostUSD?: number;
    };
    return parsed.estimatedCostUSD;
  } catch {
    return undefined;
  }
}

function readFilesInDir(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('fs').readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export { resolve as resolvePath };
