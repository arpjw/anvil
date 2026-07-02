import { describe, test, expect, beforeEach } from 'bun:test';
import { createHarness, readJson, type Harness } from './harness';

let h: Harness;

async function seedUser(): Promise<{ token: string; userId: string }> {
  const token = 'tok-1';
  const clerkId = 'clerk-1';
  h.tokens.set(token, { clerkId });
  const user = await h.repo.createUser({ clerkId });
  await h.repo.setUserGithub(user.id, {
    githubLogin: 'ghlogin',
    githubAccessToken: 'gho_test_token',
  });
  return { token, userId: user.id };
}

async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('GET /github/repos', () => {
  beforeEach(() => {
    h = createHarness();
  });

  test('returns the user repos from the github stub', async () => {
    const { token } = await seedUser();
    h.github.userRepos = [
      { fullName: 'octocat/hello', defaultBranch: 'main', private: false },
      { fullName: 'octocat/private', defaultBranch: 'trunk', private: true },
    ];

    const res = await h.authedFetch('/api/v1/github/repos', {
      method: 'GET',
      token,
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ repos: Array<{ fullName: string }> }>(res);
    expect(body.repos.length).toBe(2);
    expect(body.repos[0]!.fullName).toBe('octocat/hello');
    expect(h.github.lastToken).toBe('gho_test_token');
  });

  test('400 when github not connected', async () => {
    const token = 'tok-x';
    h.tokens.set(token, { clerkId: 'clerk-x' });
    await h.repo.createUser({ clerkId: 'clerk-x' });

    const res = await h.authedFetch('/api/v1/github/repos', {
      method: 'GET',
      token,
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('github_not_connected');
  });
});

describe('POST /github/webhook', () => {
  const secret = 'shhh';

  beforeEach(() => {
    // rebuild harness w/ webhook secret
    h = createHarness();
    // The default harness doesn't wire the webhook, so we hit the endpoint via
    // a fresh app for these tests.
  });

  async function makeAppWithSecret() {
    const { createApp } = await import('../app');
    const app = createApp({
      deps: h.deps,
      dashboardOrigin: 'http://localhost:3000',
      logger: (await import('pino')).pino({ enabled: false }),
      githubWebhookSecret: secret,
    });
    const authedFetch = async (
      path: string,
      init: RequestInit & { headers?: Record<string, string> } = {},
    ) => {
      return app.fetch(
        new Request(`http://test.local${path}`, {
          method: init.method,
          headers: init.headers,
          body: init.body,
        }),
      );
    };
    return { authedFetch };
  }

  test('rejects a request with a bad signature', async () => {
    const { authedFetch } = await makeAppWithSecret();
    const body = JSON.stringify({ action: 'opened' });
    const res = await authedFetch('/webhooks/github', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': 'sha256=' + 'a'.repeat(64),
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test('ignores non-pull_request events', async () => {
    const { authedFetch } = await makeAppWithSecret();
    const body = JSON.stringify({ zen: 'yes' });
    const sig = 'sha256=' + (await hmacHex(body, secret));
    const res = await authedFetch('/webhooks/github', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'ping',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = await readJson<{ ignored?: string }>(res);
    expect(parsed.ignored).toBe('ping');
  });

  test('marks a session merged on pull_request.closed with merged=true', async () => {
    const { authedFetch } = await makeAppWithSecret();
    // seed a session with a pr_url
    const user = await h.repo.createUser({ clerkId: 'wclerk' });
    const repo = await h.repo.createRepo({
      userId: user.id,
      fullName: 'octocat/hello',
      defaultBranch: 'main',
    });
    const session = await h.repo.createSession({
      userId: user.id,
      repoId: repo.id,
      status: 'complete',
      branch: 'main',
      request: 'x',
      model: 'claude-sonnet-4-6',
    });
    await h.repo.updateSessionPrUrl(
      session.id,
      'https://github.com/octocat/hello/pull/42',
    );

    const payload = {
      action: 'closed',
      pull_request: {
        merged: true,
        html_url: 'https://github.com/octocat/hello/pull/42',
        number: 42,
      },
    };
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + (await hmacHex(body, secret));
    const res = await authedFetch('/webhooks/github', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);

    const stored = await h.repo.findSessionById(session.id);
    expect(stored?.prState).toBe('merged');
  });

  test('returns matched:false when no session has that pr_url', async () => {
    const { authedFetch } = await makeAppWithSecret();
    const payload = {
      action: 'closed',
      pull_request: {
        merged: false,
        html_url: 'https://github.com/nobody/none/pull/99',
        number: 99,
      },
    };
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + (await hmacHex(body, secret));
    const res = await authedFetch('/webhooks/github', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const parsed = await readJson<{ matched?: boolean }>(res);
    expect(parsed.matched).toBe(false);
  });
});
