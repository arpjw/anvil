import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function seedUser(): Promise<{ token: string; userId: string; repoId: string; sessionId: string }> {
  const token = 'tok-1';
  const clerkId = 'clerk-1';
  h.tokens.set(token, { clerkId });
  const user = await h.repo.createUser({ clerkId });
  await h.repo.setUserGithub(user.id, {
    githubLogin: 'ghlogin',
    githubAccessToken: 'gho_test_token',
  });
  const repo = await h.repo.createRepo({
    userId: user.id,
    fullName: 'octocat/hello',
    defaultBranch: 'main',
  });
  const session = await h.repo.createSession({
    userId: user.id,
    repoId: repo.id,
    status: 'reviewing',
    branch: 'main',
    request: 'add readme',
    model: 'claude-sonnet-4-6',
  });
  h.github.branchShas.set('octocat/hello/main', 'baseSha');
  return { token, userId: user.id, repoId: repo.id, sessionId: session.id };
}

describe('POST /sessions/:id/pr', () => {
  test('opens a PR with only approved diffs and stores prUrl', async () => {
    const { token, sessionId } = await seedUser();

    // two approved, one rejected, one pending — only approved should ship
    const d1 = await h.repo.createEvent(sessionId, 'diff_ready', {});
    // create diffs via repo state directly using internal map
    const seedDiff = async (
      filepath: string,
      status: 'approved' | 'rejected' | 'pending',
      content: string,
    ) => {
      const id = crypto.randomUUID();
      h.repo._diffs.set(id, {
        id,
        sessionId,
        filepath,
        originalContent: '',
        newContent: content,
        status,
        createdAt: new Date(),
      });
      return id;
    };
    await seedDiff('a.ts', 'approved', 'export const a = 1;\n');
    await seedDiff('b.ts', 'approved', 'export const b = 2;\n');
    await seedDiff('c.ts', 'rejected', 'export const c = 3;\n');
    await seedDiff('d.ts', 'pending', 'export const d = 4;\n');

    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/pr`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ prUrl: string; session: { prUrl: string } }>(res);
    expect(body.prUrl).toContain('https://github.com/octocat/hello/pull/');
    expect(body.session.prUrl).toBe(body.prUrl);

    // exactly two putFile calls, both on the anvil session branch
    expect(h.github.putFileCalls.length).toBe(2);
    const paths = h.github.putFileCalls.map((c) => c.path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts']);
    for (const call of h.github.putFileCalls) {
      expect(call.branch.startsWith('anvil/session-')).toBe(true);
      expect(call.owner).toBe('octocat');
      expect(call.repo).toBe('hello');
    }

    // one PR call with correct base
    expect(h.github.prCalls.length).toBe(1);
    const prCall = h.github.prCalls[0];
    if (!prCall) throw new Error('missing PR call');
    expect(prCall.base).toBe('main');
    expect(prCall.head.startsWith('anvil/session-')).toBe(true);

    // token forwarded
    expect(h.github.lastToken).toBe('gho_test_token');

    // db updated
    const stored = await h.repo.findSessionById(sessionId);
    expect(stored?.prUrl).toBe(body.prUrl);
    void d1;
  });

  test('400 when no approved diffs', async () => {
    const { token, sessionId } = await seedUser();
    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/pr`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('no_approved_diffs');
  });

  test('reuses an existing anvil branch (idempotent)', async () => {
    const { token, sessionId } = await seedUser();
    const seedDiff = async (
      filepath: string,
      status: 'approved',
      content: string,
    ) => {
      const id = crypto.randomUUID();
      h.repo._diffs.set(id, {
        id,
        sessionId,
        filepath,
        originalContent: '',
        newContent: content,
        status,
        createdAt: new Date(),
      });
      return id;
    };
    await seedDiff('a.ts', 'approved', 'export const a = 1;\n');
    // mark the branch as already existing
    const preBranch = `anvil/session-${sessionId.slice(0, 8)}`;
    h.github.existingBranches.add(`octocat/hello/${preBranch}`);

    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/pr`, {
      method: 'POST',
      token,
    });
    expect(res.status).toBe(200);
    // createBranch throws branch_exists, is swallowed — putFile still runs
    expect(h.github.putFileCalls.length).toBe(1);
  });

  test('404 for another user', async () => {
    const { sessionId } = await seedUser();
    // second user with different token
    const otherToken = 'tok-2';
    h.tokens.set(otherToken, { clerkId: 'clerk-2' });
    await h.repo.createUser({ clerkId: 'clerk-2' });

    const res = await h.authedFetch(`/api/v1/sessions/${sessionId}/pr`, {
      method: 'POST',
      token: otherToken,
    });
    expect(res.status).toBe(404);
  });
});
