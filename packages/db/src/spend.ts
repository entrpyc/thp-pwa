import { and, eq, sql } from 'drizzle-orm';
import { PIPELINE_STEPS, type PipelineStep } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { job, spendCeilingRaise } from './schema';

/**
 * The daily spend ledger (docs/project/prd.md, 3.21.2.8; docs/project/rate-limits.md § 3).
 *
 * There is no ledger table. Every job the worker runs already writes what it cost into
 * `job.provider_meta.costUsd` on success (3.19.13), so "what has today cost" is one aggregate over
 * rows that exist for other reasons, and it cannot drift from them.
 *
 * **A day is a UTC day, decided by the database.** The worker and the API both ask here, and the
 * answer is computed from `now()` on the one clock they share, so a clock difference between two
 * processes cannot open a second budget or close one early.
 *
 * **Failed jobs count nothing.** A provider that failed billed nothing we can read, and guessing a
 * cost for a call that returned an error would be a number with no source. That is slightly
 * generous and deliberately so.
 *
 * **The ceiling in force is the larger of two numbers**: the configured default, and today's raise
 * if an admin made one. Tomorrow has no raise row, so tomorrow starts back at the default with no
 * cleanup step — which is the whole reason the raise is keyed by day.
 */

export interface SpendCeilingRaise {
  readonly ceilingUsd: number;
  readonly raisedBy: string | null;
  readonly raisedAt: Date;
  readonly reason: string | null;
}

export interface SpendLedger {
  /** What succeeded paid work has cost since the UTC day began. */
  readonly todayUsd: number;
  /** The same, split by the step that spent it. Every step is present, most at zero. */
  readonly byStep: Readonly<Record<PipelineStep, number>>;
  /** The ceiling in force today: the configured default, or today's raise if it is higher. */
  readonly ceilingUsd: number;
  /** The configured default, which is also the floor a raise cannot go under. */
  readonly defaultUsd: number;
  readonly raise: SpendCeilingRaise | null;
  /** When the UTC day ends and the budget starts again. */
  readonly dayEndsAt: Date;
}

/** The start of the current UTC day, as a `timestamptz` the `finished_at` column compares to. */
const UTC_DAY_START = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;

/** Today's date in UTC — the key a raise row is written under. */
const UTC_TODAY = sql`(now() at time zone 'utc')::date`;

export async function readSpendLedger(
  defaultUsd: number,
  executor: Executor = getDatabase(),
): Promise<SpendLedger> {
  const db = queryable(executor);

  const spent = await db
    .select({
      step: job.step,
      total: sql<string>`coalesce(sum((${job.providerMeta}->>'costUsd')::numeric), 0)`,
    })
    .from(job)
    .where(
      and(
        eq(job.status, 'succeeded'),
        sql`${job.finishedAt} >= ${UTC_DAY_START}`,
        // Only a real number counts. A row whose meta says nothing about cost — an older run, a
        // handler that returned no meta — is a row with no cost, not a row that breaks the sum.
        sql`jsonb_typeof(${job.providerMeta}->'costUsd') = 'number'`,
      ),
    )
    .groupBy(job.step);

  const byStep = Object.fromEntries(PIPELINE_STEPS.map((step) => [step, 0])) as Record<
    PipelineStep,
    number
  >;
  let todayUsd = 0;
  for (const row of spent) {
    const amount = Number(row.total);
    byStep[row.step] = amount;
    todayUsd += amount;
  }

  const [raiseRow] = await db
    .select()
    .from(spendCeilingRaise)
    .where(eq(spendCeilingRaise.day, UTC_TODAY))
    .limit(1);
  const raise: SpendCeilingRaise | null = raiseRow
    ? {
        ceilingUsd: Number(raiseRow.ceilingUsd),
        raisedBy: raiseRow.raisedBy,
        raisedAt: raiseRow.raisedAt,
        reason: raiseRow.reason,
      }
    : null;

  const [clock] = await db
    .select({
      dayEndsAt: sql<Date>`${UTC_DAY_START} + interval '1 day'`,
    })
    .from(sql`(select 1) as one`);
  const dayEndsAt = clock?.dayEndsAt instanceof Date ? clock.dayEndsAt : new Date(String(clock?.dayEndsAt));

  return {
    todayUsd: roundUsd(todayUsd),
    byStep,
    ceilingUsd: Math.max(defaultUsd, raise?.ceilingUsd ?? 0),
    defaultUsd,
    raise,
    dayEndsAt,
  };
}

/** Whether a paid step may start: it may while today's spend is under the ceiling. */
export function spendCeilingReached(ledger: SpendLedger): boolean {
  return ledger.todayUsd >= ledger.ceilingUsd;
}

export interface NewSpendCeilingRaise {
  readonly ceilingUsd: number;
  readonly raisedBy: string;
  readonly reason: string | null;
}

/**
 * Raise today's ceiling. One row per UTC day, upserted: raising twice keeps the higher number and
 * the latest author, so two admins raising in the same hour cannot lower each other. The floor
 * (the configured default) and the cap are the caller's to check — this writes what it is given.
 */
export async function raiseSpendCeilingToday(
  input: NewSpendCeilingRaise,
  executor: Executor = getDatabase(),
): Promise<SpendCeilingRaise> {
  const rows = await queryable(executor)
    .insert(spendCeilingRaise)
    .values({
      day: UTC_TODAY,
      ceilingUsd: input.ceilingUsd.toFixed(2),
      raisedBy: input.raisedBy,
      reason: input.reason,
    })
    .onConflictDoUpdate({
      target: spendCeilingRaise.day,
      set: {
        ceilingUsd: sql`greatest(${spendCeilingRaise.ceilingUsd}, excluded.ceiling_usd)`,
        raisedBy: sql`excluded.raised_by`,
        raisedAt: sql`now()`,
        reason: sql`excluded.reason`,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('raiseSpendCeilingToday returned no row');
  return {
    ceilingUsd: Number(row.ceilingUsd),
    raisedBy: row.raisedBy,
    raisedAt: row.raisedAt,
    reason: row.reason,
  };
}

/** To the cent, as a number. Provider costs are quoted to six places; a ledger reads to two. */
function roundUsd(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** `$2.14` — the one way an amount is spelled in a failure reason, a log line or a screen. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
