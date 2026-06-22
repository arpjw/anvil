import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import type { AppEnv } from '../lib/context';

export function authRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/sync', requireAuth(), (c) => {
    const user = c.get('user');
    return c.json({ user });
  });

  r.get('/me', requireAuth(), async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const repoCount = await deps.repo.countReposByUser(user.id);
    return c.json({ user, repoCount });
  });

  return r;
}
