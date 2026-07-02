import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import type { AppEnv } from '../lib/context';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export function githubRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.get('/repos', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    if (!user.githubAccessToken) {
      throw new HttpError(
        400,
        'github_not_connected',
        'connect GitHub before listing repos',
      );
    }
    const gh = deps.githubClient(user.githubAccessToken);
    const repos = await gh.listUserRepos();
    return c.json({ repos });
  });

  return r;
}

export interface WebhookDeps {
  webhookSecret: string;
}

export function githubWebhookRoutes(webhookDeps: WebhookDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/github', async (c) => {
    const deps = c.get('deps');
    const signature = c.req.header('x-hub-signature-256');
    const event = c.req.header('x-github-event');
    const rawBody = await c.req.text();

    if (!signature || !event) {
      throw new HttpError(400, 'bad_request', 'missing signature or event');
    }
    const valid = await verifyHmac(rawBody, signature, webhookDeps.webhookSecret);
    if (!valid) {
      throw new HttpError(401, 'invalid_signature', 'invalid signature');
    }

    if (event !== 'pull_request') {
      return c.json({ ok: true, ignored: event });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, 'bad_json', 'invalid JSON body');
    }
    const parsed = parsePullRequestEvent(payload);
    if (!parsed) return c.json({ ok: true, unmatched: true });

    const session = await deps.repo.findSessionByPrUrl(parsed.htmlUrl);
    if (!session) {
      logger.info({ prUrl: parsed.htmlUrl }, 'no session matched webhook');
      return c.json({ ok: true, matched: false });
    }

    if (parsed.action === 'closed' && parsed.merged) {
      await deps.repo.updateSessionPrState(session.id, 'merged');
    } else if (parsed.action === 'closed') {
      await deps.repo.updateSessionPrState(session.id, 'closed');
    } else if (parsed.action === 'reopened') {
      await deps.repo.updateSessionPrState(session.id, 'open');
    }

    return c.json({ ok: true, sessionId: session.id, prState: parsed });
  });

  return r;
}

interface ParsedPr {
  action: string;
  merged: boolean;
  htmlUrl: string;
  number: number;
}

function parsePullRequestEvent(payload: unknown): ParsedPr | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const action = typeof obj.action === 'string' ? obj.action : null;
  const pr = obj.pull_request as Record<string, unknown> | undefined;
  if (!action || !pr) return null;
  const htmlUrl = typeof pr.html_url === 'string' ? pr.html_url : null;
  const merged = typeof pr.merged === 'boolean' ? pr.merged : false;
  const number = typeof pr.number === 'number' ? pr.number : 0;
  if (!htmlUrl) return null;
  return { action, merged, htmlUrl, number };
}

async function verifyHmac(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) return false;
  const expected = signature.slice(prefix.length);
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqualHex(hex, expected);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
