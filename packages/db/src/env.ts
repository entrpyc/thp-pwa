/**
 * Server-only configuration for the datastore. Read here and nowhere else, so a missing
 * `DATABASE_URL` fails with one sentence rather than as a driver error three frames deep.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

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
