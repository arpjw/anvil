import 'dotenv/config';
import Redis from 'ioredis';
import { createApp } from './app';
import { db } from './db';
import { createPgRepository } from './db/repository';
import { migrate } from './db/migrate';
import { createClerkVerifyToken } from './middleware/auth';
import { octokitGithubClient } from './lib/github';
import { logger } from './lib/logger';
import { createBroadcaster } from './events/broadcaster';

async function main() {
  const port = Number(process.env.PORT ?? 3001);
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000';
  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret) {
    throw new Error('CLERK_SECRET_KEY is required');
  }

  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisSubscriberUrl = process.env.REDIS_SUBSCRIBER_URL ?? redisUrl;

  logger.info('running migrations');
  await migrate();
  logger.info('migrations complete');

  const redis = new Redis(redisUrl, { lazyConnect: false });
  const redisSubscriber = new Redis(redisSubscriberUrl, { lazyConnect: false });

  redis.on('error', (err) => logger.error({ err }, 'redis publisher error'));
  redisSubscriber.on('error', (err) =>
    logger.error({ err }, 'redis subscriber error'),
  );

  const broadcaster = createBroadcaster(redisSubscriber);
  broadcaster.startHeartbeat();

  const repo = createPgRepository(db);
  const verifyToken = createClerkVerifyToken(clerkSecret);

  const app = createApp({
    deps: {
      repo,
      verifyToken,
      githubClient: octokitGithubClient,
      redis,
      broadcaster,
    },
    dashboardOrigin,
    logger,
  });

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 255,
  });

  logger.info({ port: server.port, dashboardOrigin }, 'control plane listening');
}

main().catch((err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'fatal');
  process.exit(1);
});
