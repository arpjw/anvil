import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import type { AppDeps, AppEnv } from './lib/context';
import { HttpError } from './lib/errors';
import { logger as defaultLogger, type Logger } from './lib/logger';
import { authRoutes } from './routes/auth';
import { reposRoutes } from './routes/repos';
import { sessionsRoutes } from './routes/sessions';
import { diffsRoutes } from './routes/diffs';
import { prRoutes } from './routes/pr';
import { requireAuth } from './middleware/auth';
import { sseHandler } from './events/sse';

export type CreateAppOptions = {
  deps: AppDeps;
  dashboardOrigin?: string;
  logger?: Logger;
};

export function createApp(opts: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const log = opts.logger ?? defaultLogger;

  app.use(
    '*',
    cors({
      origin: opts.dashboardOrigin ?? 'http://localhost:3000',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    }),
  );

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('deps', opts.deps);
    const started = performance.now();
    try {
      await next();
    } finally {
      const duration = performance.now() - started;
      log.info(
        {
          requestId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Math.round(duration * 100) / 100,
        },
        'request',
      );
    }
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/api/v1/sessions/:id/events',
    requireAuth(),
    async (c) => {
      const user = c.get('user');
      const deps = c.get('deps');
      const sessionId = c.req.param('id');
      return sseHandler(c, sessionId, user.id, {
        repo: deps.repo,
        broadcaster: deps.broadcaster,
      });
    },
  );

  app.route('/api/v1/auth', authRoutes());
  app.route('/api/v1/repos', reposRoutes());
  app.route('/api/v1/sessions', sessionsRoutes());
  app.route('/api/v1', diffsRoutes());
  app.route('/api/v1', prRoutes());

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';

    if (err instanceof HttpError) {
      log.warn(
        { requestId, code: err.code, status: err.status, msg: err.message },
        'http error',
      );
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            requestId,
            ...(err.details ? { details: err.details } : {}),
          },
        },
        err.status as 400 | 401 | 403 | 404 | 500,
      );
    }

    if (err instanceof ZodError) {
      log.warn({ requestId, issues: err.flatten() }, 'validation error');
      return c.json(
        {
          error: {
            code: 'invalid_body',
            message: 'invalid request body',
            requestId,
            details: err.flatten(),
          },
        },
        400,
      );
    }

    log.error({ requestId, err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return c.json(
      {
        error: {
          code: 'internal_error',
          message: 'internal server error',
          requestId,
        },
      },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not_found',
          message: 'route not found',
          requestId: c.get('requestId') ?? 'unknown',
        },
      },
      404,
    ),
  );

  return app;
}
