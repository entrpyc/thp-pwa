import { describe, expect, it } from 'vitest';
import { ApiError } from '@/server/api/errors';
import {
  DEFAULT_SIGN_IN_LIMITS,
  UNKNOWN_ADDRESS_KEY,
  accountKeyFor,
  createSignInGuard,
  emailNamedBy,
  readSignInLimits,
} from '@/server/auth/sign-in-limits';

/**
 * The sign-in budget's policy (docs/project/prd.md, 3.1.20), driven with an injected clock.
 *
 * The limiter's arithmetic is proved in `rate-limit.test.ts`; what this file pins is the shape on
 * top of it — two budgets in a fixed order, what each is keyed by, which one a refused caller does
 * and does not spend, and that neither answer says which budget ran out. The integration suite
 * proves the guard is in front of the route.
 */

const T0 = 1_700_000_000_000;

const from = (address?: string) =>
  new Request('https://example.test/api/v1/auth/session', {
    method: 'POST',
    headers: address === undefined ? {} : { 'x-real-ip': address },
  });

const limits = { windowMs: 60_000, perAddress: 4, perAccount: 2 };

describe('the sign-in budget', () => {
  it('refuses with 429, a rate_limited code and a Retry-After header', () => {
    const guard = createSignInGuard(limits);

    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);

    try {
      guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
      expect.unreachable('the third attempt at one account should have been refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      const error = caught as ApiError;
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      expect(error.headers['retry-after']).toBe('60');
      expect(error.message).toContain('Too many sign-in attempts');
      expect(error.message).toContain('1 minute');
    }
  });

  it('counts an account across callers — a distributed guessing run is still one run', () => {
    const guard = createSignInGuard(limits);

    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    guard.enforce(from('198.51.100.9'), 'alice@example.test', T0);

    // A third machine, spending nothing of its own yet, is refused on Alice's behalf.
    expect(() => guard.enforce(from('192.0.2.5'), 'alice@example.test', T0)).toThrowError();
    // And that same machine can still sign in as somebody else: it was the account, not the caller.
    expect(() => guard.enforce(from('192.0.2.5'), 'bob@example.test', T0)).not.toThrow();
  });

  it('counts a caller across accounts — one machine cannot spread the cost over addresses', () => {
    const guard = createSignInGuard(limits);

    for (let n = 0; n < limits.perAddress; n += 1) {
      guard.enforce(from('203.0.113.1'), `probe-${n}@example.test`, T0);
    }

    expect(() => guard.enforce(from('203.0.113.1'), 'probe-99@example.test', T0)).toThrowError();
    // A different caller naming the same never-before-seen address is untouched.
    expect(() => guard.enforce(from('198.51.100.9'), 'probe-99@example.test', T0)).not.toThrow();
  });

  it('does not let a caller over their own budget spend an account’s budget as well', () => {
    const guard = createSignInGuard({ windowMs: 60_000, perAddress: 1, perAccount: 2 });

    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    // Four refusals from a machine that is already out of budget, all naming Alice.
    for (let n = 0; n < 4; n += 1) {
      expect(() => guard.enforce(from('203.0.113.1'), 'alice@example.test', T0)).toThrowError();
    }
    // None of them touched Alice's budget: she has one attempt of two left, from anywhere else.
    expect(() => guard.enforce(from('198.51.100.9'), 'alice@example.test', T0)).not.toThrow();
  });

  it('spends the account budget whether or not the address has an account', () => {
    // The guard cannot know, and must not behave as if it did: the same address, the same budget,
    // whatever the member list says. This test is the shape of that guarantee — the guard has no
    // database, so the only thing it could key on is the string it was given.
    const guard = createSignInGuard(limits);
    guard.enforce(from('203.0.113.1'), 'nobody@example.test', T0);
    guard.enforce(from('198.51.100.9'), 'nobody@example.test', T0);
    expect(() => guard.enforce(from('192.0.2.5'), 'nobody@example.test', T0)).toThrowError();
  });

  it('treats one address written two ways as one account', () => {
    const guard = createSignInGuard(limits);

    guard.enforce(from('203.0.113.1'), 'Alice@Example.test', T0);
    guard.enforce(from('203.0.113.1'), '  alice@example.test ', T0);
    expect(() => guard.enforce(from('203.0.113.1'), 'ALICE@EXAMPLE.TEST', T0)).toThrowError();
  });

  it('spends only the caller’s budget when the body named no account', () => {
    const guard = createSignInGuard({ windowMs: 60_000, perAddress: 2, perAccount: 1 });

    guard.enforce(from('203.0.113.1'), null, T0);
    // A second garbage body from the same caller is an attempt like any other.
    guard.enforce(from('203.0.113.1'), null, T0);
    expect(() => guard.enforce(from('203.0.113.1'), null, T0)).toThrowError();
    // No account was spent by any of it: Alice's single attempt is still hers.
    expect(() => guard.enforce(from('198.51.100.9'), 'alice@example.test', T0)).not.toThrow();
  });

  it('says the same thing whichever budget ran out', () => {
    const byCaller = createSignInGuard({ windowMs: 60_000, perAddress: 1, perAccount: 1 });
    byCaller.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    const mine = captureMessage(() =>
      byCaller.enforce(from('203.0.113.1'), 'bob@example.test', T0),
    );

    const byAccount = createSignInGuard({ windowMs: 60_000, perAddress: 99, perAccount: 1 });
    byAccount.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    const theirs = captureMessage(() =>
      byAccount.enforce(from('198.51.100.9'), 'alice@example.test', T0),
    );

    // Told apart, the two answers would say whether the caller is alone in being blocked.
    expect(mine).toBe(theirs);
  });

  it('puts every caller in one bucket when nothing said who they are', () => {
    const guard = createSignInGuard({ windowMs: 60_000, perAddress: 2, perAccount: 99 });

    guard.enforce(from(), 'alice@example.test', T0);
    guard.enforce(from(), 'bob@example.test', T0);
    expect(() => guard.enforce(from(), 'carol@example.test', T0)).toThrowError();
    expect(UNKNOWN_ADDRESS_KEY.length).toBeGreaterThan(0);
  });

  it('frees both budgets when the window passes', () => {
    const guard = createSignInGuard(limits);

    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    guard.enforce(from('203.0.113.1'), 'alice@example.test', T0);
    expect(() => guard.enforce(from('203.0.113.1'), 'alice@example.test', T0)).toThrowError();
    expect(() =>
      guard.enforce(from('203.0.113.1'), 'alice@example.test', T0 + limits.windowMs + 1),
    ).not.toThrow();
  });
});

describe('the account key', () => {
  it('is a hash, so the limiter and the log hold no address a probe supplied', () => {
    const key = accountKeyFor('alice@example.test');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('alice');
  });

  it('normalises before hashing', () => {
    expect(accountKeyFor('Alice@Example.test')).toBe(accountKeyFor('alice@example.test'));
    expect(accountKeyFor('alice@example.test')).not.toBe(accountKeyFor('bob@example.test'));
  });
});

describe('the address a body names', () => {
  it('reads a string email and leaves the rest of the shape to the parser', () => {
    expect(emailNamedBy({ email: 'alice@example.test', password: 'x' })).toBe('alice@example.test');
    expect(emailNamedBy({ email: '  alice@example.test ' })).toBe('alice@example.test');
  });

  it.each([
    ['nothing', null],
    ['a string', 'alice@example.test'],
    ['an object with no email', { password: 'x' }],
    ['an email that is not a string', { email: 42 }],
    ['an empty email', { email: '   ' }],
    ['an email longer than a field may be', { email: `${'a'.repeat(600)}@example.test` }],
  ])('answers null for %s', (_label, body) => {
    expect(emailNamedBy(body)).toBeNull();
  });
});

describe('the configured limits', () => {
  it('defaults to numbers a member who knows their password never meets', () => {
    expect(readSignInLimits({})).toEqual(DEFAULT_SIGN_IN_LIMITS);
    expect(DEFAULT_SIGN_IN_LIMITS.perAccount).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_SIGN_IN_LIMITS.perAddress).toBeGreaterThan(DEFAULT_SIGN_IN_LIMITS.perAccount);
  });

  it('reads all three settings', () => {
    expect(
      readSignInLimits({
        SIGNIN_RATE_LIMIT_WINDOW_SECONDS: '30',
        SIGNIN_RATE_LIMIT_PER_IP: '9',
        SIGNIN_RATE_LIMIT_PER_ACCOUNT: '4',
      }),
    ).toEqual({ windowMs: 30_000, perAddress: 9, perAccount: 4 });
  });

  it.each([
    ['not a number', { SIGNIN_RATE_LIMIT_PER_ACCOUNT: 'lots' }],
    ['zero', { SIGNIN_RATE_LIMIT_PER_IP: '0' }],
    ['negative', { SIGNIN_RATE_LIMIT_WINDOW_SECONDS: '-5' }],
  ])('refuses a setting that is %s, naming the variable', (_label, env) => {
    expect(() => readSignInLimits(env)).toThrowError(/SIGNIN_RATE_LIMIT/);
  });

  it('refuses an account budget above the per-caller one, which is the two variables swapped', () => {
    expect(() =>
      readSignInLimits({ SIGNIN_RATE_LIMIT_PER_IP: '10', SIGNIN_RATE_LIMIT_PER_ACCOUNT: '50' }),
    ).toThrowError(/swapped/);
  });
});

function captureMessage(run: () => void): string {
  try {
    run();
  } catch (caught) {
    if (caught instanceof ApiError) return caught.message;
    throw caught;
  }
  throw new Error('expected a refusal');
}
