'use client';
import { useState } from 'react';
import { SessionWorkspace } from '@/components/SessionWorkspace';
import type { Plan, SessionDetail, SessionStatus, UIEvent } from '@/lib/types';

const plan: Plan = {
  goal: 'Make webhook delivery resilient to temporary failures',
  context: 'The delivery worker currently makes a single request. Add bounded retries while keeping the existing signing and idempotency behavior intact.',
  filesToModify: ['src/webhooks/deliver.ts', 'tests/webhooks.test.ts'], filesToCreate: ['src/lib/backoff.ts'],
  steps: ['Extract exponential backoff with jitter into a small, testable helper.', 'Retry connection failures and 5xx responses, with a maximum of three attempts.', 'Cover successful retries, permanent failures, and signature preservation.'],
  verificationCriteria: ['TypeScript compilation passes.', 'Webhook tests cover retry limits and preserve idempotency keys.'],
  risks: ['Retries increase total delivery latency. Keep the attempt limit explicit.'],
};
const base: SessionDetail = {
  id: 'demo-7f3a8c42', userId: 'demo', repoId: 'demo', repoFullName: 'acme/platform', status: 'running',
  branch: 'main', request: 'Add reliable retries to webhook delivery', model: 'claude-sonnet-4-6', planJson: plan,
  vmIp: null, vmPort: null, prUrl: null, prState: null, startedAt: '2026-01-01T10:42:00Z', completedAt: null,
  durationSeconds: 86, createdAt: '2026-01-01T10:42:00Z', events: [],
  diffs: [{ id: 'demo-diff', sessionId: 'demo-7f3a8c42', filepath: 'src/lib/backoff.ts', originalContent: null,
    newContent: 'export function backoff(attempt: number): number {\n  const base = Math.min(1000 * 2 ** attempt, 30_000);\n  return Math.round(base * (0.5 + Math.random() * 0.5));\n}\n', status: 'pending', createdAt: '2026-01-01T10:43:00Z' },
    { id: 'demo-delivery-diff', sessionId: 'demo-7f3a8c42', filepath: 'src/webhooks/deliver.ts',
      originalContent: 'export async function deliver(url: string, init: RequestInit) {\n  return fetch(url, init);\n}\n',
      newContent: 'import { backoff } from "../lib/backoff";\n\nexport async function deliver(url: string, init: RequestInit) {\n  for (let attempt = 0; ; attempt++) {\n    try {\n      const response = await fetch(url, init);\n      if (response.status < 500 || attempt === 2) return response;\n    } catch (error) {\n      if (attempt === 2) throw error;\n    }\n    await new Promise(resolve => setTimeout(resolve, backoff(attempt)));\n  }\n}\n',
      status: 'pending', createdAt: '2026-01-01T10:43:02Z' }],
};
function event(type: string, payload: unknown, seconds: number): UIEvent { return { id: `demo-${seconds}`, type, payload, timestamp: Date.parse('2026-01-01T10:42:00Z') + seconds * 1000 }; }
const executionEvents: UIEvent[] = [
  event('context_loaded', {}, 1), event('plan_ready', { plan }, 6),
  event('branch_created', { branchName: 'anvil/session-7f3a8c42' }, 12),
  event('tool_call', { name: 'read_file', args: 'path=src/webhooks/deliver.ts' }, 14),
  event('tool_result', { preview: 'Read 86 lines. Delivery signature and request headers found.' }, 15),
  event('tool_call', { name: 'write_file', args: 'path=src/lib/backoff.ts' }, 20),
  event('shadow_attempt', { file: 'src/lib/backoff.ts', attempt: 1, maxAttempts: 3 }, 21),
  event('shadow_result', { outcome: 'committed', errorCount: 0 }, 22),
  event('file_modified', { path: 'src/lib/backoff.ts' }, 23),
  event('tool_call', { name: 'write_file', args: 'path=src/webhooks/deliver.ts' }, 27),
  event('shadow_result', { outcome: 'committed', errorCount: 0 }, 29),
  event('file_modified', { path: 'src/webhooks/deliver.ts' }, 30),
  event('phase_transition', { index: 7, total: 10, label: 'Verifying', to: 'VERIFYING' }, 35),
  event('command_running', { command: 'npm test -- webhooks' }, 36),
  event('command_output', { line: '✓ retries transient failures within the attempt limit', stream: 'stdout' }, 38),
  event('command_output', { line: '✓ preserves the original idempotency key across attempts', stream: 'stdout' }, 39),
];
export function DemoWorkspace() {
  const [scenario, setScenario] = useState<SessionStatus>('running');
  const events = scenario === 'reviewing'
    ? [event('plan_ready', { plan }, 6), event('phase_transition', { index: 4, label: 'Awaiting approval', to: 'AWAITING_APPROVAL' }, 7)]
    : scenario === 'complete' ? [...executionEvents, event('verification_pass', { rounds: 0 }, 41), event('phase_transition', { index: 10, label: 'Complete', to: 'COMPLETE' }, 45), event('done', { summary: 'Added retry limits and regression coverage.' }, 46)] : executionEvents;
  return <><div className="demo-controls"><span>Explore the Anvil workspace</span><label>Scenario <select aria-label="Preview scenario" value={scenario} onChange={e => setScenario(e.target.value as SessionStatus)}><option value="reviewing">Plan review</option><option value="running">Live execution</option><option value="complete">Completed session</option></select></label></div>
    <SessionWorkspace key={scenario} readOnly session={{ ...base, status: scenario, diffs: scenario === 'reviewing' ? [] : base.diffs }} status={scenario} events={events} connection="closed" /></>;
}
