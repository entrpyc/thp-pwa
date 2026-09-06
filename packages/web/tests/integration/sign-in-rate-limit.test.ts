import { afterAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, AUTH_SESSION_PATH, CORRELATION_ID_HEADER, isApiErrorBody } from '@thp/shared';
import { TEST_PASSWORD, closeTestDatabase, createAccount, type TestAccount } from '../support/accounts';

/**
 * The sign-in budget, driven over HTTP (docs/project/prd.md, 3.1.20).
 *
 * **Against the rate-limited server**, started by tests/setup/global.ts with three attempts per
 * account and six per caller. Every other server has the limit lifted out of the way, for the
 * reason the sign-up budget is: a test run has no proxy in front of it and is one caller as far as
 * a limiter can tell.
 *
 * What this file is for is the **wiring and the HTTP contract**: that the guard is in front of the
 * route, that the account budget spans callers and the caller budget spans accounts, that a refusal
 * is the product's envelope with a `Retry-After`, and that a refused attempt issues no session even
 * when the password was right. The arithmetic is unit-tested against an injected clock in
 * `tests/unit/sign-in-limits.test.ts`.
 *
 * Accounts are written straight into the shared database, so registering them spends no sign-up
 * budget on this server. **Each test mints its own account as well as its own client address**:
 * the account budget spans callers by design, so an account one test spent is spent for every
 * test after it, however fresh their address.
 */

const baseUrl = inject('rateLimitedBaseUrl');
const databaseUrl = inject('databaseUrl');
const { perAccount, perAddress } = inject('rateLimitedSignIn');

const SIGN_IN_URL = `${baseUrl}${API_PREFIX}${AUTH_SESSION_PATH}`;

afterAll(async () => {
  await closeTestDatabase();
});

let addresses = 0;

/** A caller nothing else in this file is. Documentation addresses, never a routable one. */
function freshAddress(): string {
  addresses += 1;
  return `203.0.113.${addresses}`;
}

interface Answer {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly correlationId: string | null;
  readonly retryAfter: string | null;
  readonly setCookie: string | null;
}

async function attempt(address: string, email: string, password: string): Promise<Answer> {
  const response = await fetch(SIGN_IN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': address },
    body: JSON.stringify({ email, password }),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    message: isApiErrorBody(parsed) ? parsed.error.message : null,
    correlationId: response.headers.get(CORRELATION_ID_HEADER),
    retryAfter: response.headers.get('retry-after'),
    setCookie: response.headers.get('set-cookie'),
  };
}

/** Spend an account's whole budget on wrong passwords, from one caller. */
async function exhaust(address: string, account: TestAccount): Promise<void> {
  for (let n = 0; n < perAccount; n += 1) {
    const wrong = await attempt(address, account.email, `not-${account.password}-${n}`);
    expect(wrong.status).toBe(401);
    expect(wrong.code).toBe('invalid_credentials');
  }
}

/** An account nothing else in this file has attempted. */
function freshAccount(label: string): Promise<TestAccount> {
  return createAccount(databaseUrl, 'member', `${label}-limited`);
}

describe('the sign-in rate limit', () => {
  it('refuses the right password once the account’s budget is spent on wrong ones', async () => {
    const alice = await freshAccount('alice');
    const address = freshAddress();
    await exhaust(address, alice);

    const refused = await attempt(address, alice.email, alice.password);
    expect(refused.status).toBe(429);
    expect(refused.code).toBe('rate_limited');
    // No session for a request the budget refused, however good the credential was.
    expect(refused.setCookie).toBeNull();
  });

  it('answers in the product envelope, with a correlation id and a Retry-After', async () => {
    const alice = await freshAccount('alice');
    const address = freshAddress();
    await exhaust(address, alice);

    const refused = await attempt(address, alice.email, alice.password);

    expect(refused.correlationId).toBeTruthy();
    expect(refused.message).toContain('Too many sign-in attempts');
    expect(refused.retryAfter).toBeTruthy();
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('is the account that is spent, not the caller: the same machine signs in as somebody else', async () => {
    const alice = await freshAccount('alice');
    const bob = await freshAccount('bob');
    const address = freshAddress();
    await exhaust(address, alice);
    expect((await attempt(address, alice.email, alice.password)).status).toBe(429);

    const asBob = await attempt(address, bob.email, bob.password);
    expect(asBob.status).toBe(201);
    expect(asBob.setCookie).toBeTruthy();
  });

  it('spans callers: a guessing run spread across machines is still one run', async () => {
    const alice = await freshAccount('alice');
    const first = freshAddress();
    const second = freshAddress();

    // Alice's budget spent from one machine; a fresh machine is refused on her behalf.
    await exhaust(first, alice);
    const refused = await attempt(second, alice.email, alice.password);
    expect(refused.status).toBe(429);

    // The refusal was an attempt from that machine all the same, so it cost one of its own — and
    // only one: the rest of its caller budget is still there for anybody else.
    for (let n = 0; n < perAddress - 1; n += 1) {
      const probe = await attempt(second, `nobody-${n}@example.test`, TEST_PASSWORD);
      expect(probe.status).toBe(401);
    }
    expect((await attempt(second, `nobody-x@example.test`, TEST_PASSWORD)).status).toBe(429);
  });

  it('spans accounts: one machine working through addresses runs out of caller budget', async () => {
    const bob = await freshAccount('bob');
    const address = freshAddress();

    for (let n = 0; n < perAddress; n += 1) {
      const probe = await attempt(address, `probe-${n}@example.test`, TEST_PASSWORD);
      // Unknown addresses answer exactly as a wrong password does — until the budget says stop.
      expect(probe.status).toBe(401);
      expect(probe.code).toBe('invalid_credentials');
    }

    const refused = await attempt(address, bob.email, bob.password);
    expect(refused.status).toBe(429);
    expect(refused.setCookie).toBeNull();
  });

  it('spends the account budget on unknown addresses too, so a refusal says nothing about membership', async () => {
    const first = freshAddress();
    const second = freshAddress();
    const nobody = `nobody-${Date.now().toString(36)}@example.test`;

    for (let n = 0; n < perAccount; n += 1) {
      expect((await attempt(first, nobody, TEST_PASSWORD)).status).toBe(401);
    }
    // From another machine, so it is the account budget answering and not the caller's.
    expect((await attempt(second, nobody, TEST_PASSWORD)).status).toBe(429);
  });

  it('does not extend the block when a refused caller keeps hammering', async () => {
    const alice = await freshAccount('alice');
    const address = freshAddress();
    await exhaust(address, alice);

    const first = await attempt(address, alice.email, alice.password);
    const later = await attempt(address, alice.email, alice.password);

    expect(first.status).toBe(429);
    expect(later.status).toBe(429);
    expect(Number(later.retryAfter)).toBeLessThanOrEqual(Number(first.retryAfter));
  });

  it('leaves every other route alone — the budget is this one route', async () => {
    const alice = await freshAccount('alice');
    const address = freshAddress();
    await exhaust(address, alice);
    expect((await attempt(address, alice.email, alice.password)).status).toBe(429);

    const health = await fetch(`${baseUrl}${API_PREFIX}/health`, {
      headers: { 'x-real-ip': address },
    });
    expect(health.status).toBe(200);
  });
});
