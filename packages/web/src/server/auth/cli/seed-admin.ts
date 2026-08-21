import { closeDatabase } from '@thp/db';
import { seedAdmin } from '../seed-admin';

/**
 * `npm run seed:admin` — the one command that puts the first person into an empty deployment.
 *
 * Reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_DISPLAY_NAME` and `SEED_ADMIN_PASSWORD`. Exits non-zero
 * and writes nothing if any of them is missing or the password is weak: an admin account nobody
 * chose the password for is worse than no admin account.
 */
async function main(): Promise<void> {
  const outcome = await seedAdmin({
    email: process.env['SEED_ADMIN_EMAIL'],
    displayName: process.env['SEED_ADMIN_DISPLAY_NAME'],
    password: process.env['SEED_ADMIN_PASSWORD'],
  });

  if (outcome.status === 'refused') {
    process.stderr.write(
      [
        'Refusing to seed an admin.',
        `  ${outcome.reason}`,
        '',
        '  Set SEED_ADMIN_EMAIL, SEED_ADMIN_DISPLAY_NAME and SEED_ADMIN_PASSWORD, then run again.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  if (outcome.status === 'exists') {
    process.stdout.write(
      `An account already exists for ${outcome.email} — left untouched, password unchanged.\n`,
    );
    return;
  }

  process.stdout.write(`Created admin ${outcome.email}.\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
