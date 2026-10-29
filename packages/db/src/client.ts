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
  /**
   * The most one statement may run, in milliseconds, before Postgres cancels it; `0` is no limit.
   * Defaults to {@link DEFAULT_STATEMENT_TIMEOUT_MS}. The migration runner passes `0`: building an
   * index over every embedding is exactly the statement this ceiling exists to stop elsewhere.
   */
  readonly statementTimeoutMs?: number;
  /**
   * How long a session may sit inside an open transaction doing nothing before Postgres ends it,
   * in milliseconds; `0` is no limit. Defaults to {@link DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS}.
   */
  readonly idleInTransactionTimeoutMs?: number;
}

/**
 * **Thirty seconds per statement** (security audit, finding 17). Nothing the application runs is
 * meant to take that long — a search is an HNSW probe and a headline over a few dozen rows, and
 * the heavy work is the worker's, in jobs — so a statement that does is one holding a pool slot
 * hostage: a pathological query, a lock nobody released, a planner gone wrong. Cancelling it costs
 * the one request; not cancelling it costs the pool.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * **Ten seconds idle inside a transaction.** Every transaction here is `withTransaction` around a
 * handful of statements; a session that opened one and went quiet is a session whose caller
 * crashed between `begin` and `commit`, and the locks it holds are what the next writer waits on.
 */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

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
    // Session settings, sent in every connection's startup packet, so they hold on every pool
    // slot without a `set` round-trip. Postgres reads both as milliseconds.
    connection: {
      statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout:
        options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    ...(requiresTls(url) ? { ssl: 'require' as const } : {}),
  });
  return {
    db: drizzle(client, { schema }),
    sql: client,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Whether the connection must be encrypted: **yes unless the server is this machine** and the URL
 * does not already say. Production runs Postgres on loopback, where TLS protects nothing; a URL
 * naming any other host is crossing a network, and a password sent over it in the clear is a
 * password the network has. A URL that carries `sslmode` has already decided and is left alone.
 */
export function requiresTls(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl')) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return !LOOPBACK_HOSTS.has(host) && !host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

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
