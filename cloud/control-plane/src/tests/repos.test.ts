import { describe, expect, test } from 'bun:test';
import { createHarness, readJson } from './harness';

async function setupUser(h: ReturnType<typeof createHarness>, clerkId: string, token: string) {
  h.tokens.set(token, { clerkId });
  const user = await h.repo.createUser({ clerkId });
  return user;
}

describe('POST /repos', () => {
  test('rejects invalid fullName format', async () => {
    const h = createHarness();
    await setupUser(h, 'clerk_owner', 'tok-a');

    const res = await h.authedFetch('/api/v1/repos', {
      token: 'tok-a',
      method: 'POST',
      body: JSON.stringify({ fullName: 'not-valid-name' }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('invalid_body');
  });

  test('rejects when GitHub API returns 404 (no access)', async () => {
    const h = createHarness();
    await setupUser(h, 'clerk_owner', 'tok-b');
    // no stub set => stub throws 404

    const res = await h.authedFetch('/api/v1/repos', {
      token: 'tok-b',
      method: 'POST',
      body: JSON.stringify({ fullName: 'someone/private-repo' }),
    });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('repo_not_found');
  });

  test('creates repo when GitHub access is confirmed', async () => {
    const h = createHarness();
    await setupUser(h, 'clerk_owner', 'tok-c');
    h.github.getResponses.set('owner/repo', { defaultBranch: 'main' });

    const res = await h.authedFetch('/api/v1/repos', {
      token: 'tok-c',
      method: 'POST',
      body: JSON.stringify({ fullName: 'owner/repo' }),
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.repo.fullName).toBe('owner/repo');
    expect(body.repo.defaultBranch).toBe('main');
  });
});

describe('DELETE /repos/:id', () => {
  test('rejects if repo belongs to different user', async () => {
    const h = createHarness();
    const owner = await setupUser(h, 'clerk_owner', 'tok-owner');
    await setupUser(h, 'clerk_other', 'tok-other');

    const repo = await h.repo.createRepo({
      userId: owner.id,
      fullName: 'owner/repo',
      defaultBranch: 'main',
    });

    const res = await h.authedFetch(`/api/v1/repos/${repo.id}`, {
      token: 'tok-other',
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    // ensure repo still exists
    expect(await h.repo.findRepoById(repo.id)).not.toBeNull();
  });

  test('deletes repo for owning user', async () => {
    const h = createHarness();
    const owner = await setupUser(h, 'clerk_owner', 'tok-owner');
    const repo = await h.repo.createRepo({
      userId: owner.id,
      fullName: 'owner/repo',
      defaultBranch: 'main',
    });

    const res = await h.authedFetch(`/api/v1/repos/${repo.id}`, {
      token: 'tok-owner',
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await h.repo.findRepoById(repo.id)).toBeNull();
  });
});
