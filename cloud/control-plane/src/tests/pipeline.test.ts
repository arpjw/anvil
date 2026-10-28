import { describe, expect, test } from 'bun:test';
import { processEvent, publishToChannel } from '../events/pipeline';
import { createMemoryRepository, FakeRedis } from './harness';

async function seedSession(
  repo: ReturnType<typeof createMemoryRepository>,
  status: 'queued' | 'provisioning' | 'running' | 'reviewing' = 'running',
) {
  const user = await repo.createUser({ clerkId: 'c1' });
  const repoRow = await repo.createRepo({
    userId: user.id,
    fullName: 'a/b',
    defaultBranch: 'main',
  });
  return repo.createSession({
    userId: user.id,
    repoId: repoRow.id,
    status,
    request: 'r',
    model: 'claude-sonnet-4-6',
  });
}

describe('publishToChannel', () => {
  test('publishes to anvil:session:<id>', async () => {
    const redis = new FakeRedis();
    await publishToChannel(redis, 'sess-1', {
      type: 'foo',
      payload: { x: 1 },
      timestamp: 12345,
    });
    expect(redis.published).toEqual([
      {
        channel: 'anvil:session:sess-1',
        message: JSON.stringify({ type: 'foo', payload: { x: 1 }, timestamp: 12345 }),
      },
    ]);
  });

  test('swallows publish errors', async () => {
    const redis = new FakeRedis();
    redis.publish = async () => {
      throw new Error('boom');
    };
    await publishToChannel(redis, 's', { type: 't', payload: null, timestamp: 0 });
  });
});

describe('processEvent', () => {
  test('persists event to DB via repo.createEvent', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo);
    const redis = new FakeRedis();
    await processEvent(repo, redis, session.id, {
      type: 'tool_call',
      payload: { name: 'read_file' },
    });
    expect(repo._events.size).toBe(1);
    const evt = Array.from(repo._events.values())[0]!;
    expect(evt.type).toBe('tool_call');
    expect(evt.sessionId).toBe(session.id);
  });

  test('publishes to anvil:session:<id> channel', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo);
    const redis = new FakeRedis();
    await processEvent(repo, redis, session.id, {
      type: 'tool_call',
      payload: { name: 'read_file' },
    });
    expect(redis.published).toHaveLength(1);
    const publish = redis.published[0]!;
    expect(publish.channel).toBe(`anvil:session:${session.id}`);
    const parsed = JSON.parse(publish.message);
    expect(parsed.type).toBe('tool_call');
    expect(parsed.payload).toEqual({ name: 'read_file' });
    expect(typeof parsed.timestamp).toBe('number');
  });

  test('plan_ready transitions running → reviewing', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo, 'running');
    const redis = new FakeRedis();
    await processEvent(repo, redis, session.id, {
      type: 'plan_ready',
      payload: { plan: 'do thing' },
    });
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('reviewing');
  });

  test('done transitions running → complete and sets duration', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo, 'running');
    const redis = new FakeRedis();
    const startedAt = Date.now() - 5000;
    await processEvent(
      repo,
      redis,
      session.id,
      { type: 'done', payload: { summary: 's' } },
      { startedAt },
    );
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('complete');
    expect(reloaded?.completedAt).toBeInstanceOf(Date);
    expect(reloaded?.durationSeconds).toBeGreaterThanOrEqual(4);
  });

  test('fatal session_error transitions running → failed', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo, 'running');
    const redis = new FakeRedis();
    await processEvent(repo, redis, session.id, {
      type: 'session_error',
      payload: { message: 'boom' },
    });
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('failed');
  });

  test('non-status events leave status untouched', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo, 'running');
    const redis = new FakeRedis();
    await processEvent(repo, redis, session.id, {
      type: 'file_committed',
      payload: { path: 'foo.ts' },
    });
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('running');
  });

  test('does not throw on Redis publish failure', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo);
    const redis = new FakeRedis();
    redis.publish = async () => {
      throw new Error('redis down');
    };
    await processEvent(repo, redis, session.id, {
      type: 'tool_call',
      payload: {},
    });
    expect(repo._events.size).toBe(1);
  });

  test('invalid transition is logged and ignored, not thrown', async () => {
    const repo = createMemoryRepository();
    const session = await seedSession(repo, 'queued');
    const redis = new FakeRedis();
    // done from queued is invalid; pipeline should swallow and leave status as-is
    await processEvent(repo, redis, session.id, {
      type: 'done',
      payload: { summary: 'x' },
    });
    const reloaded = await repo.findSessionById(session.id);
    expect(reloaded?.status).toBe('queued');
  });
});
