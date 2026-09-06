/**
 * Server-only configuration for the datastore. Read here and nowhere else, so a missing
 * `DATABASE_URL` fails with one sentence rather than as a driver error three frames deep.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The daily ceiling on provider spend, in US dollars (docs/project/prd.md, 3.21.2.8).
 *
 * Read here rather than in the worker or the web app because **both** enforce it — the worker
 * before it starts a paid step, the API before it enqueues one — and a number two processes must
 * agree on is read in one place. Two dollars is roughly five full teachings through transcription,
 * more than any real week, and small enough that a runaway loop is capped at pocket money. An
 * admin can raise a single day's ceiling above this from the pipeline view; this is the floor
 * that raise cannot go under.
 */
export const DEFAULT_SPEND_CEILING_USD_PER_DAY = 2;

export function readSpendCeilingUsdPerDay(env: EnvSource = process.env): number {
  const raw = env['SPEND_CEILING_USD_PER_DAY'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_SPEND_CEILING_USD_PER_DAY;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `SPEND_CEILING_USD_PER_DAY is "${raw}", which is not a positive amount in dollars. ` +
        'See .env.example.',
    );
  }
  return parsed;
}

export function requireDatabaseUrl(env: EnvSource = process.env): string {
  const url = env['DATABASE_URL'];
  if (!url || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres instance ' +
        '(see README.md, "Database").',
    );
  }
  return url;
}
