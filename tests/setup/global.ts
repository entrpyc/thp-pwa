import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@thp/db';
import {
  MAIL_DIR,
  REPO_ROOT,
  buildNextApp,
  freePort,
  startNextServer,
  type RunningServer,
} from './next-server';
import { createThrowawayDatabase, type ThrowawayDatabase } from './throwaway-db';

loadEnv({ path: `${REPO_ROOT}/.env`, quiet: true });

/** A host/port nothing listens on, so the "broken connection" case is genuinely broken. */
const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/nothing';

/**
 * Mail, for every server the suite starts. No SMTP is ever configured: the primary and broken-db
 * servers capture to a file the tests read, and `mail-down` refuses everything so that "a send
 * failure leaves the invitation in place" is a thing the suite can drive rather than a claim.
 */
const MAIL_FROM = 'Teaching Hub <invitations@example.test>';

function captureMail(name: string): Record<string, string> {
  return {
    MAIL_TRANSPORT: 'capture',
    MAIL_CAPTURE_PATH: resolve(MAIL_DIR, `${name}.jsonl`),
    MAIL_FROM,
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const configuredUrl = process.env['DATABASE_URL'];
  if (!configuredUrl) {
    throw new Error(
      'Integration tests need a real Postgres. Set DATABASE_URL (see README.md, "Database") — ' +
        'they are deliberately not mocked, because the migration and pgvector checks would be ' +
        'meaningless against a fake.',
    );
  }

  // The servers get a database of their own, created on the same instance and dropped afterwards.
  // From ticket 2 the suite writes rows — accounts, sessions — and it must not leave them in the
  // database the developer signs into. It also means every run starts from an empty `user` table,
  // so no test can quietly depend on what a previous run left behind.
  let appDatabase: ThrowawayDatabase | undefined;
  const servers: RunningServer[] = [];

  const stopEverything = async () => {
    await Promise.all(servers.map((server) => server.stop()));
    await appDatabase?.drop();
  };

  try {
    appDatabase = await createThrowawayDatabase(configuredUrl, 'app');
    await runMigrations({ url: appDatabase.url });

    // The primary server's port is chosen **before** the build, because `NEXT_PUBLIC_API_ORIGIN` is
    // inlined into the client bundle at build time and the browser suite drives that bundle for
    // real. The client has no same-host fallback by design (docs/project/prd.md, 5.2.2), so it has to be
    // right.
    const primaryPort = await freePort();
    await buildNextApp(`http://127.0.0.1:${primaryPort}`);

    const primary = await startNextServer({
      name: 'primary',
      databaseUrl: appDatabase.url,
      port: primaryPort,
      env: captureMail('primary'),
    });
    servers.push(primary);

    const broken = await startNextServer({
      name: 'broken-db',
      databaseUrl: UNREACHABLE_DATABASE_URL,
      env: captureMail('broken-db'),
    });
    servers.push(broken);

    // Same database as the primary, so an invitation issued here is one the primary can then
    // resend — which is exactly what "a send failure is retryable" has to mean to be worth saying.
    const mailDown = await startNextServer({
      name: 'mail-down',
      databaseUrl: appDatabase.url,
      env: { MAIL_TRANSPORT: 'failing', MAIL_FROM },
    });
    servers.push(mailDown);

    project.provide('apiBaseUrl', primary.baseUrl);
    project.provide('apiLogPath', primary.logPath);
    project.provide('brokenDbBaseUrl', broken.baseUrl);
    project.provide('mailDownBaseUrl', mailDown.baseUrl);
    project.provide('mailCapturePath', resolve(MAIL_DIR, 'primary.jsonl'));
    project.provide('databaseUrl', appDatabase.url);
  } catch (error) {
    await stopEverything();
    throw error;
  }

  return stopEverything;
}

declare module 'vitest' {
  interface ProvidedContext {
    apiBaseUrl: string;
    apiLogPath: string;
    brokenDbBaseUrl: string;
    /** A server whose mail transport refuses everything. Shares the primary's database. */
    mailDownBaseUrl: string;
    /** JSON-lines file the primary server appends every outgoing message to. */
    mailCapturePath: string;
    /** The suite's own database, not the one in `.env`. Dropped when the run ends. */
    databaseUrl: string;
  }
}
