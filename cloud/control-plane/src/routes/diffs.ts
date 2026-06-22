import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/context';

async function loadOwnedSession(
  c: import('hono').Context<AppEnv>,
  sessionId: string,
) {
  const user = c.get('user');
  const deps = c.get('deps');
  const session = await deps.repo.findSessionById(sessionId);
  if (!session || session.userId !== user.id) {
    throw new HttpError(404, 'not_found', 'session not found');
  }
  return { session, deps };
}

export function diffsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.get('/sessions/:id/diffs', async (c) => {
    const sessionId = c.req.param('id');
    const { session, deps } = await loadOwnedSession(c, sessionId);
    const diffs = await deps.repo.listDiffsBySession(session.id);
    return c.json({ diffs });
  });

  r.post('/sessions/:id/diffs/approve-all', async (c) => {
    const sessionId = c.req.param('id');
    const { session, deps } = await loadOwnedSession(c, sessionId);
    const count = await deps.repo.approveAllPendingDiffs(session.id);
    return c.json({ approved: count });
  });

  r.post('/sessions/:id/diffs/:diffId/approve', async (c) => {
    const sessionId = c.req.param('id');
    const diffId = c.req.param('diffId');
    const { session, deps } = await loadOwnedSession(c, sessionId);
    const diff = await deps.repo.findDiffById(diffId);
    if (!diff || diff.sessionId !== session.id) {
      throw new HttpError(404, 'not_found', 'diff not found');
    }
    const updated = await deps.repo.updateDiffStatus(diff.id, 'approved');
    return c.json({ diff: updated });
  });

  r.post('/sessions/:id/diffs/:diffId/reject', async (c) => {
    const sessionId = c.req.param('id');
    const diffId = c.req.param('diffId');
    const { session, deps } = await loadOwnedSession(c, sessionId);
    const diff = await deps.repo.findDiffById(diffId);
    if (!diff || diff.sessionId !== session.id) {
      throw new HttpError(404, 'not_found', 'diff not found');
    }
    const updated = await deps.repo.updateDiffStatus(diff.id, 'rejected');
    return c.json({ diff: updated });
  });

  return r;
}
