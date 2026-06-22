import { describe, expect, test } from 'bun:test';
import { buildInitialFrame } from '../events/sse';
import { createHarness, readJson } from './harness';
import { HttpError } from '../lib/errors';

describe('SSE handler', () => {
  test('buildInitialFrame returns session_state with recent events', async () => {
    const h = createHarness();
    h.tokens.set('tok-a', { clerkId: 'clerk_a' });
    const user = await h.repo.createUser({ clerkId: 'clerk_a' });
    const repoRow = await h.repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });
    await h.repo.createEvent(session.id, 'tool_call', { name: 'read_file' });
    await h.repo.createEvent(session.id, 'phase', { phase: 'planning' });

    const frame = await buildInitialFrame(h.repo, session.id, user.id);
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe('session_state');
    expect(parsed.payload.session.id).toBe(session.id);
    expect(parsed.payload.recentEvents).toHaveLength(2);
  });

  test('buildInitialFrame throws 404 for different user', async () => {
    const h = createHarness();
    const user = await h.repo.createUser({ clerkId: 'clerk_a' });
    const repoRow = await h.repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });

    try {
      await buildInitialFrame(h.repo, session.id, 'other-user-id');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
    }
  });

  test('buildInitialFrame throws 404 for nonexistent session', async () => {
    const h = createHarness();
    try {
      await buildInitialFrame(h.repo, 'no-such-id', 'no-such-user');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
    }
  });

  test('GET /sessions/:id/events rejects unauthorized request', async () => {
    const h = createHarness();
    const user = await h.repo.createUser({ clerkId: 'clerk_a' });
    const repoRow = await h.repo.createRepo({
      userId: user.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: user.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/events`);
    expect(res.status).toBe(401);
  });

  test('GET /sessions/:id/events returns 404 for another user', async () => {
    const h = createHarness();
    h.tokens.set('tok-a', { clerkId: 'clerk_a' });
    h.tokens.set('tok-b', { clerkId: 'clerk_b' });
    const a = await h.repo.createUser({ clerkId: 'clerk_a' });
    await h.repo.createUser({ clerkId: 'clerk_b' });
    const repoRow = await h.repo.createRepo({
      userId: a.id,
      fullName: 'a/b',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: a.id,
      repoId: repoRow.id,
      status: 'running',
      request: 'r',
      model: 'claude-sonnet-4-6',
    });

    const res = await h.authedFetch(`/api/v1/sessions/${session.id}/events`, {
      token: 'tok-b',
    });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('not_found');
  });
});
