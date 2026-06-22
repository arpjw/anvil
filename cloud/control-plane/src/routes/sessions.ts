import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AppDeps, AppEnv } from '../lib/context';
import { SESSION_STATUSES, type SessionStatus, type Session, type Repo, type User } from '../db/schema';
import { sessionPool } from '../vm/pool';
import { provisionSession, ProvisionError } from '../vm/provisioner';
import { startEventRelay, type EventRelaySocket } from '../vm/event-relay';
import { getVMDriver } from '../vm';

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
  } finally {
    releaseProvision(user.id, session.id);
  }
}

export function sessionsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.post('/', async (c) => {
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

    const session = await deps.repo.createSession({
      userId: user.id,
      repoId: repo.id,
      status: 'queued',
      request: parsed.data.request,
      model: parsed.data.model ?? 'claude-sonnet-4-6',
    });

    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (apiKey && trackProvision(user.id, session.id)) {
      void backgroundProvision(deps, session, repo, user, apiKey);
    }

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
      await getVMDriver().stopVM(id);
    } catch (err) {
      logger.warn({ sessionId: id, err }, 'failed to stop vm on abort');
    }
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
    const updated = await deps.repo.updateSessionStatus(id, 'running');

    if (sessionPool.get(id)) {
      try {
        sessionPool.send(id, { type: 'approve' });
      } catch (err) {
        logger.warn({ sessionId: id, err }, 'failed to send approve to vm');
      }
    }

    return c.json({ session: updated });
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
    const updated = await deps.repo.updateSessionStatus(id, 'failed');
    return c.json({ session: updated });
  });

  return r;
}
