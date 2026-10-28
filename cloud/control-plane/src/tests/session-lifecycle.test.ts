import { test, expect } from 'bun:test';
import { createHarness, createMemoryRepository, FakeRedis } from './harness';
import { processEvent } from '../events/pipeline';
import { normalizeDiffPath } from '../vm/event-relay';
import { sessionPool } from '../vm/pool';

async function seed(h = createHarness()) {
  h.tokens.set('test-token', { clerkId: 'test-owner' });
  const user = await h.repo.createUser({ clerkId: 'test-owner' });
  const repo = await h.repo.createRepo({ userId: user.id, fullName: 'example/repo', defaultBranch: 'main' });
  const session = await h.repo.createSession({ userId: user.id, repoId: repo.id, status: 'reviewing', request: 'task', model: 'claude-sonnet-4-6' });
  return { h, session };
}

test('recoverable warnings leave the session active, fatal errors fail it', async () => {
  const { h, session } = await seed();
  await processEvent(h.repo, h.deps.redis, session.id, { type: 'error', payload: { message: 'warning' } });
  expect((await h.repo.findSessionById(session.id))?.status).toBe('reviewing');
  await processEvent(h.repo, h.deps.redis, session.id, { type: 'session_failed', payload: { message: 'verification failed' } });
  expect((await h.repo.findSessionById(session.id))?.status).toBe('failed');
});

test('latest plan is persisted independently of the bounded activity replay', async () => {
  const { h, session } = await seed();
  await h.repo.updateSessionStatus(session.id, 'running');
  const plan = { goal: 'A complete plan', steps: ['first', 'second'] };
  await processEvent(h.repo, h.deps.redis, session.id, { type: 'plan_ready', payload: { plan } });
  expect((await h.repo.findSessionById(session.id))?.planJson).toEqual(plan);
});

test('new edits update the final diff, retain the initial content, and invalidate approval', async () => {
  const repo = createMemoryRepository();
  const first = await repo.createDiff({ sessionId: 'session', filepath: 'a.ts', originalContent: 'before', newContent: 'one' });
  await repo.updateDiffStatus(first.id, 'approved');
  const second = await repo.createDiff({ sessionId: 'session', filepath: 'a.ts', originalContent: 'one', newContent: 'two' });
  expect(second.id).toBe(first.id); expect(second.originalContent).toBe('before'); expect(second.newContent).toBe('two'); expect(second.status).toBe('pending');
});

test('VM diff paths are normalized for GitHub and escapes are rejected', () => {
  expect(normalizeDiffPath('/workspace/repo/src/a.ts')).toBe('src/a.ts');
  for (const path of ['/etc/passwd', '../a', '.git/config']) expect(() => normalizeDiffPath(path)).toThrow();
});

test('plan revision requires a connected runtime and valid feedback', async () => {
  const { h, session } = await seed();
  const request = (feedback: string) => h.authedFetch(`/api/v1/sessions/${session.id}/revise`, { token: 'test-token', method: 'POST', body: JSON.stringify({ feedback }) });
  expect((await request('')).status).toBe(400);
  expect((await request('Keep the public API')).status).toBe(409);
  const messages: string[] = [];
  sessionPool.add(session.id, { readyState: 1, send: data => messages.push(data), close() {} }, { sessionId: session.id, containerId: 'test', status: 'ready', ip: '127.0.0.1', port: 8080 });
  try {
    expect((await request('Keep the public API')).status).toBe(200);
    expect(JSON.parse(messages[0]!)).toEqual({ type: 'revise', payload: { feedback: 'Keep the public API' } });
    expect((await h.repo.findSessionById(session.id))?.status).toBe('running');
  } finally { sessionPool.remove(session.id); }
});

test('rejecting a plan cancels the session instead of leaving it waiting', async () => {
  const { h, session } = await seed();
  const res = await h.authedFetch(`/api/v1/sessions/${session.id}/reject`, { token: 'test-token', method: 'POST' });
  expect(res.status).toBe(200); expect((await h.repo.findSessionById(session.id))?.status).toBe('aborted');
});

test('published persistent events carry a stable replay id', async () => {
  const { h, session } = await seed(); const redis = new FakeRedis();
  await processEvent(h.repo, redis, session.id, { type: 'tool_call', payload: {} });
  const frame = JSON.parse(redis.published[0]!.message);
  const saved = await h.repo.getRecentEvents(session.id, 1);
  expect(frame.id).toBe(saved[0]!.id); expect(frame.timestamp).toBe(saved[0]!.createdAt.getTime());
});

test('provider selection uses the selected model key', async () => {
  const { modelApiKey } = await import('../routes/sessions');
  const env = { OPENAI_API_KEY: 'openai-fixture', ANTHROPIC_API_KEY: 'anthropic-fixture', GEMINI_API_KEY: 'gemini-fixture' };
  expect(modelApiKey('gpt-4o', env)).toBe('openai-fixture');
  expect(modelApiKey('claude-sonnet-4-6', env)).toBe('anthropic-fixture');
  expect(modelApiKey('gemini-2.5-pro', env)).toBe('gemini-fixture');
  expect(modelApiKey('unknown', env)).toBeUndefined();
});

test('missing provider configuration fails before creating a queued session', async () => {
  const { h, session } = await seed();
  h.deps.sessionRuntime = { apiKeyForModel: () => undefined, start: async () => { throw new Error('must not start'); } };
  const res = await h.authedFetch('/api/v1/sessions', { token: 'test-token', method: 'POST', body: JSON.stringify({ repoId: session.repoId, branch: 'main', request: 'work' }) });
  expect(res.status).toBe(503);
  expect((await h.repo.listSessionsByUser(session.userId)).length).toBe(1);
});

test('connected approval reaches the runtime before advancing the session', async () => {
  const { h, session } = await seed();
  const sent: string[] = [];
  sessionPool.add(session.id, { readyState: 1, send: data => sent.push(data), close() {} }, { sessionId: session.id, containerId: 'fixture', status: 'ready', ip: '127.0.0.1', port: 8080 });
  try {
    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/approve`, { token: 'test-token', method: 'POST' });
    expect(res.status).toBe(200);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'approve' });
    expect((await h.repo.findSessionById(session.id))?.status).toBe('running');
  } finally { sessionPool.remove(session.id); }
});
