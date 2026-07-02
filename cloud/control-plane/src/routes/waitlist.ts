import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../middleware/rate-limit';
import type { AppEnv } from '../lib/context';

const bodySchema = z.object({
  email: z.string().email().max(320),
  source: z.string().max(80).optional(),
});

export function waitlistRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post(
    '/',
    rateLimit({
      bucket: 'waitlist',
      windowSeconds: 3600,
      max: 30,
      keyFn: (c) =>
        c.req.header('x-forwarded-for') ??
        c.req.header('x-real-ip') ??
        'anon',
    }),
    async (c) => {
      const deps = c.get('deps');
      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'invalid email', {
          details: parsed.error.flatten(),
        });
      }
      const added = await deps.repo.addWaitlistSignup(
        parsed.data.email.trim().toLowerCase(),
        parsed.data.source?.trim() ?? null,
      );
      return c.json({ added, alreadyOnList: !added });
    },
  );

  r.get('/count', async (c) => {
    const deps = c.get('deps');
    const count = await deps.repo.countWaitlistSignups();
    return c.json({ count });
  });

  return r;
}
