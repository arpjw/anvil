import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';
import { indexRepoFromGithub } from '../github/index-repo';

let h: Harness;

async function seedUserAndRepo(): Promise<{ token: string; repoId: string }> {
  const token = 'tok-emb';
  h.tokens.set(token, { clerkId: 'clerk-emb' });
  const user = await h.repo.createUser({ clerkId: 'clerk-emb' });
  await h.repo.setUserGithub(user.id, {
    githubLogin: 'gh',
    githubAccessToken: 'gho_x',
  });
  const repo = await h.repo.createRepo({
    userId: user.id,
    fullName: 'octocat/hello',
    defaultBranch: 'main',
  });
  return { token, repoId: repo.id };
}

describe('indexRepoFromGithub (unit)', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('reads blobs from the tree, chunks by lines, returns a version hash', async () => {
    h.github.trees.set('octocat/hello', [
      { path: 'src/index.ts', type: 'blob', size: 400 },
      { path: 'README.md', type: 'blob', size: 200 },
      { path: 'assets/logo.png', type: 'blob', size: 999 }, // skipped: not a text ext
      { path: 'src', type: 'tree', size: 0 }, // skipped: not a blob
    ]);
    h.github.contents.set(
      'octocat/hello:src/index.ts',
      'export function hi() {\n  return 1;\n}\n'.repeat(3),
    );
    h.github.contents.set(
      'octocat/hello:README.md',
      '# hello\n\nWelcome.\n',
    );

    const result = await indexRepoFromGithub(h.deps, {
      repoId: 'r1',
      fullName: 'octocat/hello',
      branch: 'main',
      githubToken: 'gho_x',
    });

    expect(result.fileCount).toBe(2);
    expect(result.chunkCount).toBeGreaterThanOrEqual(2);
    expect(result.indexVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(result.storagePath).toBe('/tmp/anvil/embeddings/r1/index.json');
  });

  test('skips files larger than the byte cap', async () => {
    h.github.trees.set('octocat/hello', [
      { path: 'src/huge.ts', type: 'blob', size: 500_000 },
    ]);
    const result = await indexRepoFromGithub(h.deps, {
      repoId: 'r2',
      fullName: 'octocat/hello',
      branch: 'main',
      githubToken: 'gho_x',
    });
    expect(result.fileCount).toBe(0);
    expect(result.chunkCount).toBe(0);
  });
});

describe('POST /repos triggers indexing + GET /repos/:id/index-status', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('index-status returns not_started when no embedding row exists', async () => {
    const { token, repoId } = await seedUserAndRepo();
    const res = await h.authedFetch(`/api/v1/repos/${repoId}/index-status`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ indexed: boolean; status: string }>(res);
    expect(body.indexed).toBe(false);
    expect(body.status).toBe('not_started');
  });

  test('index-status reflects upserted state', async () => {
    const { token, repoId } = await seedUserAndRepo();
    await h.repo.upsertRepoEmbedding(repoId, {
      indexVersion: 'v1',
      chunkCount: 42,
      status: 'ready',
      storagePath: '/tmp/whatever',
      indexedAt: new Date('2026-07-02T00:00:00Z'),
    });
    const res = await h.authedFetch(`/api/v1/repos/${repoId}/index-status`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{
      indexed: boolean;
      status: string;
      chunkCount: number;
    }>(res);
    expect(body.indexed).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.chunkCount).toBe(42);
  });

  test('404 for another user', async () => {
    const { repoId } = await seedUserAndRepo();
    const otherToken = 'tok-other';
    h.tokens.set(otherToken, { clerkId: 'clerk-other' });
    await h.repo.createUser({ clerkId: 'clerk-other' });
    const res = await h.authedFetch(`/api/v1/repos/${repoId}/index-status`, {
      token: otherToken,
    });
    expect(res.status).toBe(404);
  });
});
