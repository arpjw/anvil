import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AppDeps, AppEnv } from '../lib/context';
import { SESSION_STATUSES, type SessionStatus, type Session, type Repo, type User } from '../db/schema';
import { sessionPool } from '../vm/pool';
import { vmPoolManager } from '../vm/pool-manager';
import { provisionSession, ProvisionError } from '../vm/provisioner';
import { startEventRelay, type EventRelaySocket } from '../vm/event-relay';
import { getVMDriver } from '../vm';
import { processEvent } from '../events/pipeline';

const sessionStatusSchema = z.enum(SESSION_STATUSES);

const createBodySchema = z.object({
  repoId: z.string().uuid(),
  branch: z.string().min(1),
  request: z.string().min(1).max(10_000),
  model: z.string().min(1).optional(),
});

const ABORTABLE: ReadonlySet<SessionStatus> = new Set([
  'queued',
  'provisioning',
  'running',
  'reviewing',
]);

const MAX_CONCURRENT_PER_USER = 3;
const activeProvisions = new Map<string, Set<string>>();

function trackProvision(userId: string, sessionId: string): boolean {
  const current = activeProvisions.get(userId) ?? new Set();
  if (current.size >= MAX_CONCURRENT_PER_USER) return false;
  current.add(sessionId);
  activeProvisions.set(userId, current);
  return true;
}

function releaseProvision(userId: string, sessionId: string): void {
  const current = activeProvisions.get(userId);
  if (!current) return;
  current.delete(sessionId);
  if (current.size === 0) activeProvisions.delete(userId);
}

async function backgroundProvision(
  deps: AppDeps,
  session: Session,
  repo: Repo,
  user: User,
  apiKey: string,
): Promise<void> {
  try {
    const result = await provisionSession(
      { session, repo, user, apiKey },
      { appDeps: deps },
    );
    sessionPool.add(session.id, result.wsConnection, result.vmHandle);
    startEventRelay(
      session.id,
      result.wsConnection as unknown as EventRelaySocket,
      deps,
    );

    result.wsConnection.send(
      JSON.stringify({
        type: 'start',
        payload: {
          request: session.request,
          repoPath: '/workspace/repo',
          model: session.model,
          apiKey,
          sessionId: session.id,
        },
      }),
    );
  } catch (err) {
    if (err instanceof ProvisionError) {
      logger.warn(
        { sessionId: session.id, code: err.code, message: err.message },
        'provision failed',
      );
    } else {
      logger.error({ sessionId: session.id, err }, 'unexpected provision error');
    }
    await processEvent(deps.repo, deps.redis, session.id, { type: 'session_error', payload: { message: 'Runtime provisioning failed.' } });
  } finally {
    releaseProvision(user.id, session.id);
  }
}

export function modelApiKey(model: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (model.startsWith('claude-')) return env.ANTHROPIC_API_KEY;
  if (model.startsWith('gpt-') || /^o[134](?:-|$)/.test(model)) return env.OPENAI_API_KEY;
  if (model.startsWith('gemini-')) return env.GEMINI_API_KEY;
  if (model.startsWith('moonshot-') || model.startsWith('kimi-')) return env.MOONSHOT_API_KEY;
  return undefined;
}

function requireRuntimeKey(deps: AppDeps, model: string): string {
  const key = deps.sessionRuntime ? deps.sessionRuntime.apiKeyForModel(model) : modelApiKey(model);
  if (!key) throw new HttpError(503, 'provider_unavailable', 'The selected model has no configured provider key. Ask the operator to configure it.');
  return key;
}

async function launch(deps: AppDeps, session: Session, repo: Repo, user: User, key: string): Promise<void> {
  try {
    if (deps.sessionRuntime) await deps.sessionRuntime.start(session, repo, user, key);
    else await backgroundProvision(deps, session, repo, user, key);
  } catch {
    await processEvent(deps.repo, deps.redis, session.id, { type: 'session_error', payload: { message: 'Runtime provisioning failed.' } });
  } finally {
    releaseProvision(user.id, session.id);
  }
}

async function queueSession(deps: AppDeps, repo: Repo, user: User, input: { branch: string; request: string; model: string }): Promise<Session> {
  const key = requireRuntimeKey(deps, input.model);
  const reservation = crypto.randomUUID();
  if (!trackProvision(user.id, reservation)) throw new HttpError(429, 'provisioning_limit', 'Too many sessions are provisioning. Try again shortly.');
  try {
    const session = await deps.repo.createSession({ userId: user.id, repoId: repo.id, status: 'queued', ...input });
    releaseProvision(user.id, reservation);
    trackProvision(user.id, session.id);
    void launch(deps, session, repo, user, key);
    return session;
  } catch (err) {
    releaseProvision(user.id, reservation);
    throw err;
  }
}

export function sessionsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.post(
    '/',
    rateLimit({
      bucket: 'session_create',
      windowSeconds: 3600,
      max: 20,
    }),
    async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const body = await c.req.json().catch(() => null);
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'invalid request body', {
        details: parsed.error.flatten(),
      });
    }

    const repo = await deps.repo.findRepoById(parsed.data.repoId);
    if (!repo || repo.userId !== user.id) {
      throw new HttpError(404, 'repo_not_found', 'repo not found');
    }

    const session = await queueSession(deps, repo, user, {
      branch: parsed.data.branch,
      request: parsed.data.request,
      model: parsed.data.model ?? 'claude-sonnet-4-6',
    });

    return c.json({ session }, 201);
  });

  r.get('/', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const statusParam = c.req.query('status');
    let status: SessionStatus | undefined;
    if (statusParam) {
      const parsed = sessionStatusSchema.safeParse(statusParam);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_status', 'unknown status filter');
      }
      status = parsed.data;
    }
    const sessions = await deps.repo.listSessionsByUser(user.id, { status });
    return c.json({ sessions });
  });

  r.get('/:id', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    return c.json({ session });
  });

  r.delete('/:id', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    if (!ABORTABLE.has(session.status as SessionStatus)) {
      throw new HttpError(
        400,
        'invalid_state',
        `cannot abort session in status ${session.status}`,
      );
    }
    const updated = await deps.repo.updateSessionStatus(id, 'aborted');

    if (sessionPool.get(id)) {
      try {
        sessionPool.send(id, { type: 'abort' });
      } catch (err) {
        logger.warn({ sessionId: id, err }, 'failed to send abort to vm');
      }
    }
    try {
      await vmPoolManager.release(id);
    } catch (err) {
      logger.warn({ sessionId: id, err }, 'failed to release vm on abort');
    }
    // Best-effort direct stop (in case the VM was never tracked by the pool).
    try {
      await getVMDriver().stopVM(id);
    } catch { /* already released */ }
    sessionPool.remove(id);
    releaseProvision(user.id, id);

    return c.json({ session: updated });
  });

  r.post('/:id/approve', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    if (session.status !== 'reviewing') {
      throw new HttpError(
        400,
        'invalid_state',
        `cannot approve session in status ${session.status}`,
      );
    }
    const entry = sessionPool.get(id);
    if (!entry || entry.ws.readyState !== 1) throw new HttpError(409, 'runtime_disconnected', 'The runtime is disconnected.');
    sessionPool.send(id, { type: 'approve' });
    await processEvent(deps.repo, deps.redis, id, { type: 'plan_approved', payload: {} });
    const updated = await deps.repo.findSessionById(id);

    return c.json({ session: updated });
  });

  r.get('/:id/checkpoint', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    const checkpoint = await deps.repo.getSessionCheckpoint(id);
    if (!checkpoint) {
      throw new HttpError(404, 'no_checkpoint', 'no checkpoint for this session');
    }
    return c.json({ checkpoint });
  });

  r.post('/:id/resume', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    if (session.status !== 'failed') {
      throw new HttpError(
        400,
        'invalid_state',
        `session must be in failed state to resume (was ${session.status})`,
      );
    }
    const checkpoint = await deps.repo.getSessionCheckpoint(id);
    if (!checkpoint) {
      throw new HttpError(400, 'no_checkpoint', 'session has no checkpoint to resume from');
    }

    const repo = await deps.repo.findRepoById(session.repoId);
    if (!repo) {
      throw new HttpError(404, 'repo_gone', 'session repo no longer exists');
    }

    // Phase checkpoints do not contain a VM filesystem snapshot. Retry in a
    // new session, retaining the failed session's diffs and event history.
    const retried = await queueSession(deps, repo, user, {
      branch: session.branch ?? repo.defaultBranch,
      request: session.request,
      model: session.model,
    });
    return c.json({ session: retried, retryOf: id, recovery: 'fresh_checkout' });
  });

  r.post('/:id/reject', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'session not found');
    }
    if (session.status !== 'reviewing') {
      throw new HttpError(
        400,
        'invalid_state',
        `cannot reject session in status ${session.status}`,
      );
    }
    if (sessionPool.get(id)) sessionPool.send(id, { type: 'reject' });
    await processEvent(deps.repo, deps.redis, id, { type: 'session_cancelled', payload: { summary: 'Plan rejected by user.' } });
    const updated = await deps.repo.findSessionById(id);
    return c.json({ session: updated });
  });

  r.post('/:id/revise', async c => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    const session = await deps.repo.findSessionById(id);
    if (!session || session.userId !== c.get('user').id) throw new HttpError(404, 'not_found', 'session not found');
    if (session.status !== 'reviewing') throw new HttpError(400, 'invalid_state', 'Only a pending plan can be revised.');
    const body = z.object({ feedback: z.string().trim().min(1).max(4000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, 'invalid_body', 'Provide 1 to 4000 characters of revision feedback.');
    const entry = sessionPool.get(id);
    if (!entry || entry.ws.readyState !== 1) throw new HttpError(409, 'runtime_disconnected', 'The runtime is disconnected. Wait for it to reconnect.');
    sessionPool.send(id, { type: 'revise', payload: body.data });
    await processEvent(deps.repo, deps.redis, id, { type: 'plan_revision_requested', payload: body.data });
    return c.json({ session: await deps.repo.findSessionById(id) });
  });

  return r;
}
