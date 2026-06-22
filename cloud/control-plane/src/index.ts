import 'dotenv/config';
import { createApp } from './app';
import { db } from './db';
import { createPgRepository } from './db/repository';
import { migrate } from './db/migrate';
import { createClerkVerifyToken } from './middleware/auth';
import { octokitGithubClient } from './lib/github';
import { logger } from './lib/logger';

async function main() {
  const port = Number(process.env.PORT ?? 3001);
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000';
  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret) {
    throw new Error('CLERK_SECRET_KEY is required');
  }

  logger.info('running migrations');
  await migrate();
  logger.info('migrations complete');

  const repo = createPgRepository(db);
  const verifyToken = createClerkVerifyToken(clerkSecret);

  const app = createApp({
    deps: {
      repo,
      verifyToken,
      githubClient: octokitGithubClient,
    },
    dashboardOrigin,
    logger,
  });

  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  logger.info({ port: server.port, dashboardOrigin }, 'control plane listening');
}

main().catch((err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'fatal');
  process.exit(1);
});
