import type { EvalResult } from './run.js';

export interface EvalSummary {
  total: number;
  resolved: number;
  resolvedRate: number;
  totalCostUSD: number;
  avgDurationSeconds: number;
  failureReasons: Record<string, number>;
}

export function scoreResults(results: EvalResult[]): EvalSummary {
  const total = results.length;
  const resolved = results.filter((r) => r.resolved).length;
  const totalCostUSD = results.reduce((s, r) => s + (r.costUSD ?? 0), 0);
  const avgDurationSeconds =
    total > 0
      ? Math.round(
          results.reduce((s, r) => s + r.durationSeconds, 0) / total,
        )
      : 0;

  const failureReasons: Record<string, number> = {};
  for (const r of results) {
    if (r.resolved) continue;
    const reason = shorten(r.error ?? classifyFailure(r));
    failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
  }

  return {
    total,
    resolved,
    resolvedRate: total > 0 ? resolved / total : 0,
    totalCostUSD,
    avgDurationSeconds,
    failureReasons,
  };
}

function classifyFailure(r: EvalResult): string {
  if (r.failed.length > 0 && r.passed.length === 0) return 'no tests passed';
  if (r.failed.length > 0) return `${r.failed.length} test(s) still failing`;
  return 'unknown';
}

function shorten(msg: string): string {
  const m = msg.replace(/\s+/g, ' ').trim();
  return m.length > 80 ? m.slice(0, 79) + '…' : m;
}

// ── Report ───────────────────────────────────────────────────────────────────

export function printReport(summary: EvalSummary, results: EvalResult[]): void {
  const bar = '='.repeat(6);
  console.log('');
  console.log(`${bar} Anvil SWE-bench Verified (${summary.total} tasks) ${bar}`);
  console.log(
    `Resolved:   ${summary.resolved} / ${summary.total}  ` +
      `(${(summary.resolvedRate * 100).toFixed(1)}%)`,
  );
  console.log(`Total cost: $${summary.totalCostUSD.toFixed(2)}`);
  console.log(`Avg time:   ${summary.avgDurationSeconds}s per task`);
  console.log('');

  const solved = results.filter((r) => r.resolved);
  if (solved.length > 0) {
    console.log(`Resolved instances (${solved.length}):`);
    for (const r of solved) console.log(`  ${r.instanceId}`);
    console.log('');
  }

  const failed = results.filter((r) => !r.resolved);
  if (failed.length > 0) {
    console.log(`Failed instances (${failed.length}):`);
    for (const r of failed) {
      const reason = r.error ?? classifyFailure(r);
      console.log(`  ${r.instanceId}  ${dim(`(${shorten(reason)})`)}`);
    }
    console.log('');
  }

  if (Object.keys(summary.failureReasons).length > 0) {
    console.log('Failure reasons:');
    const sorted = Object.entries(summary.failureReasons).sort(
      (a, b) => b[1] - a[1],
    );
    for (const [reason, count] of sorted) {
      console.log(`  ${String(count).padStart(3)}× ${reason}`);
    }
  }
}

// Minimal ANSI dim to avoid a chalk dependency in eval/.
function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
