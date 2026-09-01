import { describe, expect, it } from 'vitest';
import { clientAddress } from '@/server/api/client-address';
import { createRateLimiter } from '@/server/api/rate-limit';
import {
  DEFAULT_SIGN_UP_LIMITS,
  UNKNOWN_ADDRESS_KEY,
  createSignUpGuard,
  describeWait,
  readSignUpLimits,
} from '@/server/auth/sign-up-limits';
import { ApiError } from '@/server/api/errors';

/**
 * The rate limiter, its key, and the policy over the two.
 *
 * All of it is driven with an injected clock rather than by waiting, which is what lets the window
 * behaviour be asserted exactly — a limiter test that passes because a real second went by has
 * proved that a second went by. The integration suite proves the same limiter is wired to the
 * route; this file is where the arithmetic lives.
 */

const T0 = 1_700_000_000_000;

describe('the sliding-window limiter', () => {
  it('allows up to the limit and refuses the next one', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(true);

    const refused = limiter.spend('a', T0);
    expect(refused.allowed).toBe(false);
    expect(refused.spent).toBe(3);
  });

  it('counts each key separately', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0).allowed).toBe(false);
    // A different caller is untouched by the first one's spending.
    expect(limiter.spend('b', T0).allowed).toBe(true);
  });

  it('slides: a request falls out of the window exactly when it ages past it', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    expect(limiter.spend('a', T0 + 999).allowed).toBe(false);
    // A request made at T0 occupies a 1000ms window until T0 + 1000, and is gone *at* it. Pinned
    // because it is the boundary `retryAfterMs` is computed against: the moment the wait reaches
    // zero has to be the moment the next request is allowed, or the number the caller was handed
    // sends them back one millisecond early.
    expect(limiter.spend('a', T0 + 1000).allowed).toBe(true);
  });

  it('hands back a wait that is over exactly when the budget frees up', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    const refused = limiter.spend('a', T0 + 250);
    expect(refused.retryAfterMs).toBe(750);
    // Waiting precisely that long is enough — never one millisecond short of it.
    expect(limiter.spend('a', T0 + 250 + refused.retryAfterMs).allowed).toBe(true);
  });

  it('is a sliding window and not a fixed one — no double burst at the boundary', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 10 });

    // Two spent at the very end of what a fixed window would call "this window".
    expect(limiter.spend('a', T0 + 900).allowed).toBe(true);
    expect(limiter.spend('a', T0 + 999).allowed).toBe(true);
    // A fixed window would reset here and allow two more immediately. A sliding one does not.
    expect(limiter.spend('a', T0 + 1001).allowed).toBe(false);
  });

  it('says how long until the budget frees up, measured from the oldest request', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    limiter.spend('a', T0 + 400);

    const refused = limiter.spend('a', T0 + 500);
    // The oldest is at T0 and leaves the window at T0 + 1000, which is 500ms away.
    expect(refused.retryAfterMs).toBe(500);
  });

  it('does not extend the block when a refused caller keeps trying', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 10 });

    limiter.spend('a', T0);
    const first = limiter.spend('a', T0 + 100);
    const afterHammering = [1, 2, 3, 4].map((n) => limiter.spend('a', T0 + 100 + n));

    expect(first.allowed).toBe(false);
    expect(afterHammering.every((verdict) => !verdict.allowed)).toBe(true);
    // A refusal spends nothing, so the wait keeps counting down rather than resetting.
    expect(afterHammering[3]?.retryAfterMs).toBeLessThan(first.retryAfterMs);
    // And the caller is free again exactly when the one request they did spend ages out.
    expect(limiter.spend('a', T0 + 1001).allowed).toBe(true);
  });

  it('evicts the least recently seen key rather than growing without bound', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });

    limiter.spend('oldest', T0);
    limiter.spend('middle', T0 + 1);
    limiter.spend('newest', T0 + 2);

    expect(limiter.size()).toBe(2);
    // `oldest` was dropped, so it gets a fresh budget; `middle` and `newest` kept theirs.
    expect(limiter.spend('oldest', T0 + 3).allowed).toBe(true);
    expect(limiter.spend('newest', T0 + 3).allowed).toBe(false);
  });

  it('does not let a caller evict themselves into a fresh budget by hammering', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1 });

    expect(limiter.spend('a', T0).allowed).toBe(true);
    // Every one of these is refused, and none of them drops `a` to make room for `a`.
    for (let n = 1; n <= 5; n += 1) {
      expect(limiter.spend('a', T0 + n).allowed).toBe(false);
    }
  });

  it.each([
    ['a limit of zero', { limit: 0, windowMs: 1000, maxKeys: 1 }],
    ['a fractional limit', { limit: 1.5, windowMs: 1000, maxKeys: 1 }],
    ['a window of zero', { limit: 1, windowMs: 0, maxKeys: 1 }],
    ['no room for a single key', { limit: 1, windowMs: 1000, maxKeys: 0 }],
  ])('refuses to be built with %s', (_label, policy) => {
    expect(() => createRateLimiter(policy)).toThrowError();
  });
});

describe('who the request came from', () => {
  const request = (headers: Record<string, string>) =>
    new Request('https://example.test/api/v1/auth/sign-up', { method: 'POST', headers });

  it('prefers X-Real-IP, which the proxy overwrites', () => {
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes the LAST X-Forwarded-For entry, because that is the one the proxy appended', () => {
    // The first entries are whatever the caller sent. Trusting them hands the caller their own
    // bucket key and makes the limit free to bypass.
    expect(clientAddress(request({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('prefers X-Real-IP over anything in X-Forwarded-For', () => {
    const headers = { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.4' };
    expect(clientAddress(request(headers))).toBe('203.0.113.7');
  });

  it('answers null when nothing in front of the app said who called', () => {
    expect(clientAddress(request({}))).toBeNull();
  });

  it.each([
    ['an empty header', { 'x-real-ip': '   ' }],
    ['a trailing comma only', { 'x-forwarded-for': ' , ' }],
    ['an absurdly long value', { 'x-real-ip': 'x'.repeat(200) }],
  ])('answers null for %s rather than making it a key', (_label, headers) => {
    expect(clientAddress(request(headers))).toBeNull();
  });

  it('reads one host as one key however it was written', () => {
    expect(clientAddress(request({ 'x-real-ip': '[::1]:443' }))).toBe('::1');
    expect(clientAddress(request({ 'x-real-ip': '::1' }))).toBe('::1');
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7:51234' }))).toBe('203.0.113.7');
    expect(clientAddress(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });
});

describe('the sign-up budget', () => {
  const from = (address?: string) =>
    new Request('https://example.test/api/v1/auth/sign-up', {
      method: 'POST',
      headers: address === undefined ? {} : { 'x-real-ip': address },
    });

  const limits = { windowMs: 60_000, perAddress: 2, total: 3 };

  it('refuses with 429, a rate_limited code and a Retry-After header', () => {
    const guard = createSignUpGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);

    try {
      guard.enforce(from('203.0.113.1'), T0);
      expect.unreachable('the third attempt should have been refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      const error = caught as ApiError;
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      // The wait is a number the client is given rather than one it has to invent.
      expect(error.headers['retry-after']).toBe('60');
      expect(error.message).toContain('1 minute');
    }
  });

  it('leaves a different caller alone', () => {
    const guard = createSignUpGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();

    // Somebody else's budget is untouched by that.
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
  });

  it('closes the route once the ceiling is reached, however many callers spent it', () => {
    const guard = createSignUpGuard(limits);

    // Two callers, two each — but the ceiling is three, so the fourth request across the route is
    // refused even though its own caller had budget left.
    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('198.51.100.9'), T0);

    expect(() => guard.enforce(from('198.51.100.9'), T0)).toThrowError(/Too many sign-up attempts/);
    // And a third caller who has spent nothing at all is refused too. That is the cost of the
    // ceiling, and it is deliberate rather than a bug.
    expect(() => guard.enforce(from('192.0.2.5'), T0)).toThrowError();
  });

  it('does not let a caller over their own budget spend the route ceiling as well', () => {
    const guard = createSignUpGuard({ windowMs: 60_000, perAddress: 1, total: 2 });

    guard.enforce(from('203.0.113.1'), T0);
    // Four refusals from a caller who is already out of budget.
    for (let n = 0; n < 4; n += 1) {
      expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    }
    // None of them touched the ceiling: the second caller still has the route's remaining request.
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
  });

  it('says the same thing whichever budget ran out', () => {
    const perCaller = createSignUpGuard({ windowMs: 60_000, perAddress: 1, total: 99 });
    perCaller.enforce(from('203.0.113.1'), T0);
    const mine = captureMessage(() => perCaller.enforce(from('203.0.113.1'), T0));

    const ceiling = createSignUpGuard({ windowMs: 60_000, perAddress: 99, total: 1 });
    ceiling.enforce(from('203.0.113.1'), T0);
    const everyones = captureMessage(() => ceiling.enforce(from('198.51.100.9'), T0));

    // Told apart, the two answers would say whether the caller is alone in being blocked.
    expect(mine).toBe(everyones);
  });

  it('puts every caller in one bucket when nothing said who they are', () => {
    const guard = createSignUpGuard(limits);

    guard.enforce(from(), T0);
    guard.enforce(from(), T0);
    // Over-restricting rather than under-restricting is the right way for a limiter to fail when
    // it cannot tell two callers apart.
    expect(() => guard.enforce(from(), T0)).toThrowError();
    expect(UNKNOWN_ADDRESS_KEY.length).toBeGreaterThan(0);
  });

  it('frees the budget when the window passes', () => {
    const guard = createSignUpGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    expect(() => guard.enforce(from('203.0.113.1'), T0 + limits.windowMs + 1)).not.toThrow();
  });
});

describe('the configured limits', () => {
  it('defaults to a budget generous enough for a room of people signing up together', () => {
    expect(readSignUpLimits({})).toEqual(DEFAULT_SIGN_UP_LIMITS);
    // Not an arbitrary assertion: the whole argument for these numbers is that an honest burst
    // from one wifi is never refused, and a burst is more than a handful.
    expect(DEFAULT_SIGN_UP_LIMITS.perAddress).toBeGreaterThanOrEqual(15);
    expect(DEFAULT_SIGN_UP_LIMITS.total).toBeGreaterThan(DEFAULT_SIGN_UP_LIMITS.perAddress);
  });

  it('reads all three settings', () => {
    expect(
      readSignUpLimits({
        SIGNUP_RATE_LIMIT_WINDOW_SECONDS: '30',
        SIGNUP_RATE_LIMIT_PER_IP: '4',
        SIGNUP_RATE_LIMIT_TOTAL: '40',
      }),
    ).toEqual({ windowMs: 30_000, perAddress: 4, total: 40 });
  });

  it.each([
    ['not a number', { SIGNUP_RATE_LIMIT_PER_IP: 'lots' }],
    ['zero', { SIGNUP_RATE_LIMIT_PER_IP: '0' }],
    ['negative', { SIGNUP_RATE_LIMIT_TOTAL: '-5' }],
  ])('refuses a setting that is %s, naming the variable', (_label, env) => {
    expect(() => readSignUpLimits(env)).toThrowError(/SIGNUP_RATE_LIMIT/);
  });

  it('refuses a ceiling below the per-caller budget, which would refuse one caller early', () => {
    // Not a style rule: a total under the per-caller budget means the route closes for everybody
    // before any single caller has spent what they were told they had.
    expect(() =>
      readSignUpLimits({ SIGNUP_RATE_LIMIT_PER_IP: '50', SIGNUP_RATE_LIMIT_TOTAL: '10' }),
    ).toThrowError(/below/);
  });
});

describe('the wait a person is told about', () => {
  it.each([
    [1, '1 second'],
    [45, '45 seconds'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [600, '10 minutes'],
  ])('describes %i seconds as "%s"', (seconds, expected) => {
    expect(describeWait(seconds)).toBe(expected);
  });
});

function captureMessage(run: () => void): string {
  try {
    run();
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error('expected the call to be refused');
}
