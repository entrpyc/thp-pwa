import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from '@thp/db';
import { API_PREFIX, AUTH_SESSION_PATH } from '@thp/shared';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../../../tests/setup/throwaway-db';
import { startNextServer, type RunningServer } from '../../../../tests/setup/next-server';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SEED_PASSWORD = 'first-admin-chosen-passphrase';

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the seeder exactly as the documented command does — `npm run seed:admin` through the same
 * entry point — rather than calling the function it wraps. What the operator will actually type is
 * the thing worth testing.
 */
async function runSeedAdmin(
  databaseUrl: string,
  env: Record<string, string | undefined>,
): Promise<CommandResult> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(REPO_ROOT, 'scripts/with-env.mjs'),
      resolve(REPO_ROOT, 'packages/web/src/server/auth/cli/seed-admin.ts'),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        SEED_ADMIN_EMAIL: undefined,
        SEED_ADMIN_DISPLAY_NAME: undefined,
        SEED_ADMIN_PASSWORD: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code: number = await new Promise((done) => child.on('close', (value) => done(value ?? 1)));
  return { code, stdout, stderr };
}

describe('the documented command creates the first admin', () => {
  let target: ThrowawayDatabase;
  let sql: postgres.Sql;
  let server: RunningServer;

  beforeAll(async () => {
    target = await createThrowawayDatabase(inject('databaseUrl'), 'seedadmin');
    await runMigrations({ url: target.url });
    sql = postgres(target.url, { max: 2, onnotice: () => {} });
    // A server pointed at the fresh database, so "and that account can sign in" is answered over
    // real HTTP against a database whose only account is the seeded one.
    server = await startNextServer({ name: 'seed-admin', databaseUrl: target.url });
  }, 240_000);

  afterAll(async () => {
    await server?.stop();
    await sql?.end({ timeout: 5 });
    await target?.drop();
  }, 60_000);

  interface AccountRow {
    readonly id: string;
    readonly email: string;
    readonly password_hash: string;
  }

  async function accountRows(): Promise<AccountRow[]> {
    const rows = await sql<AccountRow[]>`
      select id, email, password_hash from "user" order by created_at
    `;
    return [...rows];
  }

  it('refuses a weak password and creates nothing', async () => {
    const result = await runSeedAdmin(target.url, {
      SEED_ADMIN_EMAIL: 'weak@example.test',
      SEED_ADMIN_DISPLAY_NAME: 'Weak',
      SEED_ADMIN_PASSWORD: 'short',
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('SEED_ADMIN_PASSWORD');
    expect(await accountRows()).toEqual([]);
  }, 120_000);

  it('refuses an absent password and creates nothing', async () => {
    const result = await runSeedAdmin(target.url, {
      SEED_ADMIN_EMAIL: 'absent@example.test',
      SEED_ADMIN_DISPLAY_NAME: 'Absent',
    });

    expect(result.code).not.toBe(0);
    expect(await accountRows()).toEqual([]);
  }, 120_000);

  it('creates an admin that can then sign in', async () => {
    const result = await runSeedAdmin(target.url, {
      SEED_ADMIN_EMAIL: 'First.Admin@Example.Test',
      SEED_ADMIN_DISPLAY_NAME: 'First Admin',
      SEED_ADMIN_PASSWORD: SEED_PASSWORD,
    });

    expect(result.code, result.stderr).toBe(0);
    const rows = await accountRows();
    expect(rows).toHaveLength(1);
    // Stored normalised, whatever case it was configured in.
    expect(rows[0]?.email).toBe('first.admin@example.test');
    expect(rows[0]?.password_hash).not.toContain(SEED_PASSWORD);
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);

    const signIn = await fetch(`${server.baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first.admin@example.test', password: SEED_PASSWORD }),
    });
    expect(signIn.status).toBe(201);
    expect(signIn.headers.get('set-cookie')).toContain('HttpOnly');
  }, 120_000);

  it('run twice, creates no duplicate and does not reset the password', async () => {
    const before = await accountRows();
    expect(before).toHaveLength(1);

    const result = await runSeedAdmin(target.url, {
      SEED_ADMIN_EMAIL: 'first.admin@example.test',
      SEED_ADMIN_DISPLAY_NAME: 'Renamed Admin',
      SEED_ADMIN_PASSWORD: 'a-completely-different-passphrase',
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/already exists/i);

    const after = await accountRows();
    expect(after).toHaveLength(1);
    // The same hash, byte for byte: re-seeding an existing admin is a back door, not a convenience.
    expect(after[0]?.password_hash).toBe(before[0]?.password_hash);

    // And the original password still works.
    const signIn = await fetch(`${server.baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first.admin@example.test', password: SEED_PASSWORD }),
    });
    expect(signIn.status).toBe(201);
  }, 120_000);
});
