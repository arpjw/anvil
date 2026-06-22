import { describe, expect, test } from 'bun:test';
import { createHarness, readJson } from './harness';
import type { SessionStatus } from '../db/schema';

async function seed(h: ReturnType<typeof createHarness>, clerkId: string, token: string) {
  h.tokens.set(token, { clerkId });
  const user = await h.repo.createUser({ clerkId });
  const repo = await h.repo.createRepo({
    userId: user.id,
    fullName: 'owner/repo',
    defaultBranch: 'main',
  });
  return { user, repo };
}

async function createSession(
  h: ReturnType<typeof createHarness>,
  userId: string,
  repoId: string,
  status: SessionStatus = 'queued',
) {
  return h.repo.createSession({
    userId,
    repoId,
    status,
    request: 'do the thing',
    model: 'claude-sonnet-4-6',
  });
}

describe('POST /sessions', () => {
  test('creates session with status=queued', async () => {
    const h = createHarness();
    const { repo } = await seed(h, 'clerk_a', 'tok-a');

    const res = await h.authedFetch('/api/v1/sessions', {
      token: 'tok-a',
      method: 'POST',
      body: JSON.stringify({
        repoId: repo.id,
        branch: 'main',
        request: 'add login flow',
        model: 'claude-sonnet-4-6',
      }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.session.status).toBe('queued');
    expect(body.session.request).toBe('add login flow');
  });

  test('rejects creation on another user\'s repo', async () => {
    const h = createHarness();
    const { repo } = await seed(h, 'clerk_owner', 'tok-owner');
    h.tokens.set('tok-other', { clerkId: 'clerk_other' });
    await h.repo.createUser({ clerkId: 'clerk_other' });

    const res = await h.authedFetch('/api/v1/sessions', {
      token: 'tok-other',
      method: 'POST',
      body: JSON.stringify({
        repoId: repo.id,
        branch: 'main',
        request: 'evil',
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /sessions', () => {
  test('returns only current user\'s sessions', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    const b = await seed(h, 'clerk_b', 'tok-b');

    await createSession(h, a.user.id, a.repo.id);
    await createSession(h, a.user.id, a.repo.id);
    await createSession(h, b.user.id, b.repo.id);

    const resA = await h.authedFetch('/api/v1/sessions', { token: 'tok-a' });
    const bodyA = await readJson(resA);
    expect(bodyA.sessions).toHaveLength(2);
    expect(bodyA.sessions.every((s: { userId: string }) => s.userId === a.user.id)).toBe(true);
  });
});

describe('GET /sessions/:id', () => {
  test('returns 404 for another user\'s session', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    h.tokens.set('tok-b', { clerkId: 'clerk_b' });
    await h.repo.createUser({ clerkId: 'clerk_b' });

    const session = await createSession(h, a.user.id, a.repo.id);

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}`, {
      token: 'tok-b',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /sessions/:id/approve', () => {
  test('transitions queued → fails (wrong state)', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    const session = await createSession(h, a.user.id, a.repo.id, 'queued');

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/approve`, {
      token: 'tok-a',
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('invalid_state');
  });

  test('transitions reviewing → running (correct)', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    const session = await createSession(h, a.user.id, a.repo.id, 'reviewing');

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/approve`, {
      token: 'tok-a',
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.session.status).toBe('running');
  });
});

describe('DELETE /sessions/:id', () => {
  test('sets running session to aborted', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    const session = await createSession(h, a.user.id, a.repo.id, 'running');

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}`, {
      token: 'tok-a',
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.session.status).toBe('aborted');
  });

  test('rejects abort on completed session', async () => {
    const h = createHarness();
    const a = await seed(h, 'clerk_a', 'tok-a');
    const session = await createSession(h, a.user.id, a.repo.id, 'complete');

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}`, {
      token: 'tok-a',
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });
});
