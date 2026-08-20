import postgres from 'postgres';

export interface ThrowawayDatabase {
  readonly url: string;
  readonly name: string;
  drop(): Promise<void>;
}

/**
 * Create an empty database, hand back its URL, and drop it afterwards. The migration tests need a
 * genuinely empty target — asserting "migrations apply" against an already-migrated database
 * proves nothing.
 */
export async function createThrowawayDatabase(
  adminUrl: string,
  label: string,
): Promise<ThrowawayDatabase> {
  const suffix = Math.floor(Math.random() * 1e9).toString(36);
  const name = `thp_test_${label}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const parsed = new URL(adminUrl);
  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';

  const admin = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  parsed.pathname = `/${name}`;
  const url = parsed.toString();

  return {
    url,
    name,
    async drop() {
      const cleanup = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`,
        );
        await cleanup.unsafe(`drop database if exists "${name}"`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
