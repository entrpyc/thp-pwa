import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type CreateDatabaseOptions } from './client';

/**
 * Where the checked-in SQL migrations live. Resolved from this module rather than from `cwd`, so
 * `npm run migrate` behaves the same from the repository root and from inside the package.
 */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export interface RunMigrationsOptions extends CreateDatabaseOptions {
  /** Path to the folder holding the SQL files and the journal. */
  readonly migrationsFolder?: string;
}

/**
 * Apply every pending migration, in journal order, then close the connection it opened.
 *
 * Idempotent: Drizzle records each applied migration in `drizzle.__drizzle_migrations` and skips
 * what is already there, so running this twice is a no-op the second time.
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<void> {
  const { migrationsFolder = MIGRATIONS_DIR, ...connection } = options;
  const handle = createDatabase({ max: 1, ...connection });
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}
