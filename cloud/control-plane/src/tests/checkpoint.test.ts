import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';

let h: Harness;

async function seedFailedSession(): Promise<{ token: string; sessionId: string }> {
  const token = 'tok-cp';
  h.tokens.set(token, { clerkId: 'clerk-cp' });
  const user = await h.repo.createUser({ clerkId: 'clerk-cp' });
  const repo = await h.repo.createRepo({
    userId: user.id,
    fullName: 'octocat/hello',
    defaultBranch: 'main',
  });
  const session = await h.repo.createSession({
    userId: user.id,
    repoId: repo.id,
    status: 'failed',
    branch: 'main',
    request: 'do a thing',
    model: 'claude-sonnet-4-6',
  });
  return { token, sessionId: session.id };
}

describe('GET /sessions/:id/checkpoint', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('404 when no checkpoint has been persisted', async () => {
    const { token, sessionId } = await seedFailedSession();
    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/checkpoint`, {
      token,
    });
    expect(res.status).toBe(404);
    const body = await readJson<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('no_checkpoint');
  });

  test('returns the checkpoint when one exists', async () => {
    const { token, sessionId } = await seedFailedSession();
    await h.repo.checkpointSession(sessionId, {
      phase: 'VERIFYING',
      state: { completedPhases: ['INITIALIZING', 'EXPLORING'] },
    });
    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/checkpoint`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ checkpoint: { phase: string } }>(res);
    expect(body.checkpoint.phase).toBe('VERIFYING');
  });
});

describe('POST /sessions/:id/resume', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('400 when session is not in failed state', async () => {
    const token = 'tok-cp-2';
    h.tokens.set(token, { clerkId: 'clerk-cp-2' });
    const user = await h.repo.createUser({ clerkId: 'clerk-cp-2' });
    const repo = await h.repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: user.id,
      repoId: repo.id,
      status: 'complete',
      branch: 'main',
      request: 'x',
      model: 'm',
    });
    await h.repo.checkpointSession(session.id, {
      phase: 'VERIFYING',
      state: {},
    });
    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/resume`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(400);
  });

  test('400 when no checkpoint exists', async () => {
    const { token, sessionId } = await seedFailedSession();
    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/resume`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('no_checkpoint');
  });

  test('retries in a fresh session and preserves the failed session', async () => {
    const { token, sessionId } = await seedFailedSession();
    await h.repo.checkpointSession(sessionId, {
      phase: 'VERIFYING',
      state: { completedPhases: ['INITIALIZING', 'EXPLORING'] },
    });
    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/resume`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{
      session: { id: string; status: string };
      retryOf: string;
      recovery: string;
    }>(res);
    expect(body.session.status).toBe('queued');
    expect(body.session.id).not.toBe(sessionId);
    expect(body.retryOf).toBe(sessionId);
    expect(body.recovery).toBe('fresh_checkout');
    expect((await h.repo.findSessionById(sessionId))?.status).toBe('failed');
  });
});
