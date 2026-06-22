import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/context';
import { SESSION_STATUSES, type SessionStatus } from '../db/schema';

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
