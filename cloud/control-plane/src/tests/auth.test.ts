import { describe, expect, test } from 'bun:test';
import { createHarness, createMemoryRepository, readJson } from './harness';
import { getCurrentUser } from '../middleware/auth';

describe('requireAuth middleware', () => {
  test('returns 401 with no token', async () => {
    const h = createHarness();
    const res = await h.authedFetch('/api/v1/auth/me');
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('unauthorized');
  });

  test('returns 401 with invalid token', async () => {
    const h = createHarness();
    const res = await h.authedFetch('/api/v1/auth/me', {
      token: 'not-a-real-token',
    });
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('unauthorized');
  });

  test('passes with valid mock token and attaches user', async () => {
    const h = createHarness();
    h.tokens.set('good-token', { clerkId: 'clerk_user_abc' });

    const res = await h.authedFetch('/api/v1/auth/me', {
      token: 'good-token',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.user.clerkId).toBe('clerk_user_abc');
    expect(body.repoCount).toBe(0);
  });
});

describe('getCurrentUser', () => {
  test('creates new user on first login', async () => {
    const repo = createMemoryRepository();
    const user = await getCurrentUser(repo, 'clerk_new_user');
    expect(user.clerkId).toBe('clerk_new_user');
    expect(repo._users.size).toBe(1);
  });

  test('returns existing user on subsequent calls', async () => {
    const repo = createMemoryRepository();
    const first = await getCurrentUser(repo, 'clerk_repeat');
    const second = await getCurrentUser(repo, 'clerk_repeat');
    expect(second.id).toBe(first.id);
    expect(repo._users.size).toBe(1);
  });
});
