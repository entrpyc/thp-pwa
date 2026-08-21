import { createDatabase, insertUser, type DatabaseHandle } from '@thp/db';
import { API_PREFIX, AUTH_SESSION_PATH, SESSION_COOKIE_NAME, type Role } from '@thp/shared';
import { hashPassword } from '@/server/auth/password';

/**
 * Test accounts and sessions.
 *
 * Ticket 1's integration suite drove the diagnostics routes anonymously. From ticket 2 they require a
 * session like everything else, so the suite needs a way in — this is that way, and it goes through
 * the real sign-in route over HTTP rather than forging a cookie, because a helper that forges one
 * would stop the tests from proving anything about signing in.
 */

/** Long enough for the seeder's own rule, and obviously not a real password. */
export const TEST_PASSWORD = 'test-password-not-a-secret';

let handle: DatabaseHandle | undefined;

export function testDatabase(databaseUrl: string): DatabaseHandle {
  handle ??= createDatabase({ url: databaseUrl, max: 4 });
  return handle;
}

export async function closeTestDatabase(): Promise<void> {
  const current = handle;
  handle = undefined;
  if (current) await current.close();
}

export interface TestAccount {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/** A fresh account, with an address unique to this call so tests never collide. */
export async function createAccount(
  databaseUrl: string,
  role: Role,
  label = 'user',
  password: string = TEST_PASSWORD,
): Promise<TestAccount> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const email = `${label}-${suffix}@example.test`;
  const row = await insertUser(
    {
      email,
      passwordHash: await hashPassword(password),
      displayName: `Test ${label}`,
      role,
    },
    testDatabase(databaseUrl),
  );
  return { id: row.id, email: row.email, displayName: row.displayName, password };
}

export interface SignInResponse {
  readonly status: number;
  readonly setCookie: string | null;
  readonly cookie: string | null;
  readonly body: unknown;
}

/** Sign in over HTTP and hand back the cookie header a later request can send. */
export async function signIn(
  baseUrl: string,
  email: string,
  password: string,
): Promise<SignInResponse> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = response.headers.get('set-cookie');
  return {
    status: response.status,
    setCookie,
    cookie: setCookie === null ? null : cookieFromSetCookie(setCookie),
    body: await response.json().catch(() => undefined),
  };
}

/** The `name=value` pair a client would send back, without the attributes. */
export function cookieFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

export function sessionTokenFromCookie(cookie: string): string {
  const [, value] = cookie.split('=');
  return decodeURIComponent(value ?? '');
}

/** Create an account, sign in as it, and return both. The common two lines of every auth test. */
export async function signedInAccount(
  baseUrl: string,
  databaseUrl: string,
  role: Role,
  label = 'user',
): Promise<{ account: TestAccount; cookie: string }> {
  const account = await createAccount(databaseUrl, role, label);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) {
    throw new Error(`sign-in for ${account.email} returned ${result.status} and no cookie`);
  }
  return { account, cookie: result.cookie };
}

export const SESSION_COOKIE = SESSION_COOKIE_NAME;
