import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { requireDatabaseUrl } from './env';
import * as schema from './schema';

export type Sql = postgres.Sql;
export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly sql: Sql;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly url?: string;
  readonly max?: number;
  /** Seconds to wait for a TCP connection before giving up. Kept short so health stays honest. */
  readonly connectTimeoutSeconds?: number;
}

/**
 * Build an isolated handle. Migrations and tests use this; application code uses {@link getDatabase}
 * so the process holds exactly one pool.
 */
export function createDatabase(options: CreateDatabaseOptions = {}): DatabaseHandle {
  const url = options.url ?? requireDatabaseUrl();
  const client = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    sql: client,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

let handle: DatabaseHandle | undefined;

/**
 * The single database module the API reaches Postgres through. One pool per process, created on
 * first use.
 */
export function getDatabase(): DatabaseHandle {
  handle ??= createDatabase();
  return handle;
}

export async function closeDatabase(): Promise<void> {
  const current = handle;
  handle = undefined;
  if (current) await current.close();
}

export interface PingResult {
  readonly reachable: boolean;
  readonly latencyMs: number | null;
  readonly error?: string;
}

/**
 * Round-trip a real query. The health route reports what this returns, so "healthy" means the
 * database answered — not that a connection string was configured.
 */
export async function pingDatabase(target: DatabaseHandle = getDatabase()): Promise<PingResult> {
  const startedAt = performance.now();
  try {
    await target.db.execute(sql`select 1 as ok`);
    return { reachable: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (cause) {
    return {
      reachable: false,
      latencyMs: null,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
