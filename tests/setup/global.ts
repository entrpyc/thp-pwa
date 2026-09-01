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
import { TEST_BIBLE } from './bible';
import { createThrowawayDatabase, type ThrowawayDatabase } from './throwaway-db';
import { TEST_MEDIA, ensureTestBucket, type MediaEnvironment } from './media-bucket';

loadEnv({ path: `${REPO_ROOT}/.env`, quiet: true });

/** A host/port nothing listens on, so the "broken connection" case is genuinely broken. */
const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/nothing';

/**
 * Mail, for every server the suite starts. No SMTP is ever configured: the primary and broken-db
 * servers capture to a file the tests read, and `mail-down` refuses everything so that "a send
 * failure leaves the invitation in place" is a thing the suite can drive rather than a claim.
 */
const MAIL_FROM = 'Teaching Hub <invitations@example.test>';

/**
 * **The `mail-down` server's transport, said in a way `.env` cannot overrule.**
 *
 * `THP_MOCK_EXTERNAL` wins over any named transport and resolves to `capture`, which is right for
 * every other server and fatal for this one: a developer with the switch set in `.env` — which
 * `.env.example` recommends — gets a "mail is down" server that captures happily and sends every
 * message, so "a send failure leaves the invitation in place" passes on a machine where no send
 * ever failed.
 *
 * So the switch is turned **off** here and the three adapters it would have faked are named
 * individually instead. That is the same move {@link TEST_BIBLE} makes one block up and for the
 * same reason — the suite's configuration is the suite's, never the developer's — and it keeps the
 * property that matters: the only thing real about this server is that its mail refuses.
 */
const FAILING_MAIL = {
  THP_MOCK_EXTERNAL: 'false',
  MAIL_TRANSPORT: 'failing',
  MAIL_FROM,
  // What the switch was covering. Named here so turning it off widens nothing.
  ASR_PROVIDER: 'fake',
  GENERATE_PROVIDER: 'fake',
} as const;

/**
 * **The sign-up budget, for every server but one.**
 *
 * The suite registers dozens of accounts, all of them from 127.0.0.1 with no proxy in front — so
 * as far as the limiter can tell, the entire test run is one caller. Left at the shipped defaults
 * the twenty-first registration in the run would be refused, and which test that landed on would
 * depend on the order the files happened to run in. That is not a limiter finding a bug; it is a
 * suite testing its own arithmetic.
 *
 * So the limit is lifted out of the way here, the same move {@link TEST_BIBLE} and
 * {@link FAILING_MAIL} make: the suite's configuration is the suite's. What proves the limiter
 * works is the server below, which has one, plus the unit tests over the policy itself.
 */
const UNLIMITED_SIGN_UP = {
  SIGNUP_RATE_LIMIT_WINDOW_SECONDS: '600',
  SIGNUP_RATE_LIMIT_PER_IP: '100000',
  SIGNUP_RATE_LIMIT_TOTAL: '100000',
} as const;

/**
 * **The server that has a budget**, and the only one.
 *
 * Three per caller, so a fourth request is a refusal a test can drive in four lines rather than in
 * twenty. The window is long on purpose — five minutes is far longer than the run — because a short
 * one would make every assertion here a race against the clock, and a limiter test that passes
 * because a window expired has proved nothing. Each test uses a client address of its own instead,
 * which is a fresh budget without a fresh server.
 *
 * The whole-route ceiling is set out of reach for the same reason it is set generously in
 * production: it is a backstop, its logic is exercised exhaustively in the unit tests where a clock
 * can be held still, and a ceiling low enough to trip here would trip on whichever test ran last.
 */
const TIGHT_SIGN_UP = {
  SIGNUP_RATE_LIMIT_WINDOW_SECONDS: '300',
  SIGNUP_RATE_LIMIT_PER_IP: '3',
  SIGNUP_RATE_LIMIT_TOTAL: '1000',
} as const;

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

  // The suite's own bucket on the MinIO container. Its configuration is the harness's, not the
  // developer's: `.env` is where a deployment's real bucket credentials live, and that bucket has
  // no delete path — so the suite is deliberately unable to reach anything but the container. See
  // tests/setup/media-bucket.ts.
  const media: MediaEnvironment = TEST_MEDIA;
  await ensureTestBucket(media);

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
      env: { ...media, ...TEST_BIBLE, ...UNLIMITED_SIGN_UP, ...captureMail('primary') },
    });
    servers.push(primary);

    const broken = await startNextServer({
      name: 'broken-db',
      databaseUrl: UNREACHABLE_DATABASE_URL,
      env: { ...media, ...TEST_BIBLE, ...UNLIMITED_SIGN_UP, ...captureMail('broken-db') },
    });
    servers.push(broken);

    // Same database as the primary, so an invitation issued here is one the primary can then
    // resend — which is exactly what "a send failure is retryable" has to mean to be worth saying.
    const mailDown = await startNextServer({
      name: 'mail-down',
      databaseUrl: appDatabase.url,
      env: { ...media, ...TEST_BIBLE, ...UNLIMITED_SIGN_UP, ...FAILING_MAIL },
    });
    servers.push(mailDown);

    // Same database as the primary, so an account registered against it is a real account in the
    // same member list — the refusal being tested is the limiter's, not a different world's.
    const rateLimited = await startNextServer({
      name: 'rate-limited',
      databaseUrl: appDatabase.url,
      env: { ...media, ...TEST_BIBLE, ...TIGHT_SIGN_UP, ...captureMail('rate-limited') },
    });
    servers.push(rateLimited);

    project.provide('apiBaseUrl', primary.baseUrl);
    project.provide('apiLogPath', primary.logPath);
    project.provide('brokenDbBaseUrl', broken.baseUrl);
    project.provide('mailDownBaseUrl', mailDown.baseUrl);
    project.provide('rateLimitedBaseUrl', rateLimited.baseUrl);
    project.provide('rateLimitedSignUp', {
      perAddress: Number(TIGHT_SIGN_UP.SIGNUP_RATE_LIMIT_PER_IP),
      windowSeconds: Number(TIGHT_SIGN_UP.SIGNUP_RATE_LIMIT_WINDOW_SECONDS),
    });
    project.provide('mailCapturePath', resolve(MAIL_DIR, 'primary.jsonl'));
    project.provide('databaseUrl', appDatabase.url);
    project.provide('mediaSettings', media);
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
    /**
     * A server with a real sign-up budget — three per caller. Every other server has the limit
     * lifted out of the way, because the suite is one caller as far as a limiter can tell.
     */
    rateLimitedBaseUrl: string;
    /** What that server was configured with, so no test restates a number the harness chose. */
    rateLimitedSignUp: { readonly perAddress: number; readonly windowSeconds: number };
    /** JSON-lines file the primary server appends every outgoing message to. */
    mailCapturePath: string;
    /** The suite's own database, not the one in `.env`. Dropped when the run ends. */
    databaseUrl: string;
    /**
     * The suite's own bucket on the MinIO container, and the credentials the servers use for it.
     * Never what `.env` names, and not dropped when the run ends — nothing in this repository
     * deletes from a bucket.
     */
    mediaSettings: {
      readonly MEDIA_ENDPOINT: string;
      readonly MEDIA_REGION: string;
      readonly MEDIA_BUCKET: string;
      readonly MEDIA_ACCESS_KEY_ID: string;
      readonly MEDIA_SECRET_ACCESS_KEY: string;
    };
  }
}
