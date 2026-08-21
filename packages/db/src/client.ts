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

/**
 * Whether a failed write was refused by a unique constraint (SQLSTATE `23505`).
 *
 * Here rather than at the call site because the **shape** of a driver error is this package's
 * business, exactly as query construction is: Drizzle wraps the driver's error as a `cause`, and a
 * caller in `packages/web` checking `error.code` would be reaching through two layers it is not
 * supposed to know about — and would silently stop working the day either layer changes how it
 * wraps.
 *
 * Used where a unique index is the mechanism rather than a backstop — `recording.original_media_key`
 * is the one that makes "finalise the same upload twice" produce one row instead of two, and a
 * check-then-insert has a window in which two requests both find nothing.
 */
export function isUniqueViolation(cause: unknown): boolean {
  for (let current: unknown = cause, depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current !== 'object') break;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A transaction on the pool, as Drizzle hands it to a `db.transaction` callback.
 *
 * Derived from the callback's own parameter rather than named as a Drizzle type, so it cannot drift
 * from what `transaction` actually passes.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Where a query runs: the pool, a transaction on it, or the handle that wraps the pool.
 *
 * **This is what lets one function be called both ways.** `enqueueJob` is called on its own by the
 * API's queue adapter and *inside* the transaction that marks a step succeeded — and those have to
 * be the same function, or the chain rule would be enqueuing through a second code path with its
 * own idea of what `attempt` is.
 */
export type Executor = Database | Transaction | DatabaseHandle;

/** The query builder behind an executor. A handle wraps one; a database or a transaction is one. */
export function queryable(executor: Executor = getDatabase()): Database | Transaction {
  return 'db' in executor ? executor.db : executor;
}

/**
 * Run `work` in a transaction, committing when it returns and rolling back when it throws.
 *
 * Nested by design: passing a transaction runs `work` in a savepoint of it rather than opening a
 * second one, so a caller never has to know whether it is already inside one.
 */
export async function withTransaction<T>(
  work: (tx: Transaction) => Promise<T>,
  executor: Executor = getDatabase(),
): Promise<T> {
  return queryable(executor).transaction(work);
}
