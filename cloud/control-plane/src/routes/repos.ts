import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { HttpError } from '../lib/errors';
import type { AppEnv } from '../lib/context';

const fullNameRe = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const createSchema = z.object({
  fullName: z.string().regex(fullNameRe, 'expected owner/repo'),
  defaultBranch: z.string().min(1).optional(),
});

export function reposRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth());

  r.get('/', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const repos = await deps.repo.listReposByUser(user.id);
    return c.json({ repos });
  });

  r.post(
    '/',
    rateLimit({ bucket: 'repo_create', windowSeconds: 3600, max: 30 }),
    async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'invalid request body', {
        details: parsed.error.flatten(),
      });
    }
    const { fullName, defaultBranch } = parsed.data;
    const [owner, repoName] = fullName.split('/') as [string, string];

    const gh = deps.githubClient(user.githubAccessToken);
    const ghRepo = await gh.reposGet(owner, repoName);

    const created = await deps.repo.createRepo({
      userId: user.id,
      fullName,
      defaultBranch: defaultBranch ?? ghRepo.defaultBranch ?? 'main',
    });
    return c.json({ repo: created }, 201);
  });

  r.delete('/:id', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const existing = await deps.repo.findRepoById(id);
    if (!existing || existing.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'repo not found');
    }
    await deps.repo.deleteRepo(id);
    return c.json({ ok: true });
  });

  r.get('/:id/branches', async (c) => {
    const user = c.get('user');
    const deps = c.get('deps');
    const id = c.req.param('id');
    const existing = await deps.repo.findRepoById(id);
    if (!existing || existing.userId !== user.id) {
      throw new HttpError(404, 'not_found', 'repo not found');
    }
    const [owner, repoName] = existing.fullName.split('/') as [string, string];
    const gh = deps.githubClient(user.githubAccessToken);
    const branches = await gh.reposListBranches(owner, repoName);
    return c.json({ branches });
  });

  return r;
}
