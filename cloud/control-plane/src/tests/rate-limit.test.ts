import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, type Harness } from './harness';

let h: Harness;

async function seedUser(token: string, clerkId: string) {
  h.tokens.set(token, { clerkId });
  const user = await h.repo.createUser({ clerkId });
  return user;
}

describe('rate limiting', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('session_create bucket allows 20/hour then 429s', async () => {
    const token = 'tok-rl';
    const user = await seedUser(token, 'clerk-rl');
    const repo = await h.repo.createRepo({
      userId: user.id,
      fullName: 'o/r',
      defaultBranch: 'main',
    });
    h.github.getResponses.set('o/r', { defaultBranch: 'main' });

    const body = JSON.stringify({
      repoId: repo.id,
      branch: 'main',
      request: 'do a thing',
    });

    // 20 allowed
    for (let i = 0; i < 20; i++) {
      const res = await h.authedFetch('/api/v1/sessions', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(201);
    }

    // 21st fails
    const over = await h.authedFetch('/api/v1/sessions', {
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(over.status).toBe(429);
    const parsed = (await over.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('rate_limited');
  });
});
