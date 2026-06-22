import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

export async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const migrationsFolder = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle',
  );

  const migrationClient = postgres(databaseUrl, { max: 1 });
  const migrationDb = drizzle(migrationClient);

  try {
    await drizzleMigrate(migrationDb, { migrationsFolder });
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  migrate()
    .then(() => {
      console.log('migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error('migration failed', err);
      process.exit(1);
    });
}
