import { describe, expect, it } from 'vitest';
import { ApiError } from '@/server/api/errors';
import {
  DEFAULT_PASSWORD_RESET_LIMITS,
  UNKNOWN_ADDRESS_KEY,
  createPasswordResetGuard,
  readPasswordResetLimits,
} from '@/server/password-reset/limits';

/**
 * The reset-request budget's policy (docs/project/prd.md, 3.1.21), driven with an injected clock.
 *
 * The limiter's arithmetic is proved in `rate-limit.test.ts`; what this file pins is the shape on
 * top of it — the same two budgets registration holds, in the same order, with the same rule that
 * a refused caller does not spend the ceiling. The integration suite proves the guard is in front
 * of the route and that a refused request sends nothing.
 */

const T0 = 1_700_000_000_000;

const from = (address?: string) =>
  new Request('https://example.test/api/v1/auth/password-reset', {
    method: 'POST',
    headers: address === undefined ? {} : { 'x-real-ip': address },
  });

const limits = { windowMs: 60_000, perAddress: 2, total: 3 };

describe('the reset-request budget', () => {
  it('refuses with 429, a rate_limited code and a Retry-After header', () => {
    const guard = createPasswordResetGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);

    try {
      guard.enforce(from('203.0.113.1'), T0);
      expect.unreachable('the third request should have been refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      const error = caught as ApiError;
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      expect(error.headers['retry-after']).toBe('60');
      expect(error.message).toContain('Too many password-reset requests');
      expect(error.message).toContain('1 minute');
    }
  });

  it('leaves a different caller alone', () => {
    const guard = createPasswordResetGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
  });

  it('closes the route once the ceiling is reached, however many callers spent it', () => {
    const guard = createPasswordResetGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('198.51.100.9'), T0);

    expect(() => guard.enforce(from('198.51.100.9'), T0)).toThrowError(
      /Too many password-reset requests/,
    );
    // A caller who has spent nothing is refused too. That is the cost of the ceiling.
    expect(() => guard.enforce(from('192.0.2.5'), T0)).toThrowError();
  });

  it('does not let a caller over their own budget spend the route ceiling as well', () => {
    const guard = createPasswordResetGuard({ windowMs: 60_000, perAddress: 1, total: 2 });

    guard.enforce(from('203.0.113.1'), T0);
    for (let n = 0; n < 4; n += 1) {
      expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    }
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
  });

  it('says the same thing whichever budget ran out', () => {
    const perCaller = createPasswordResetGuard({ windowMs: 60_000, perAddress: 1, total: 99 });
    perCaller.enforce(from('203.0.113.1'), T0);
    const mine = captureMessage(() => perCaller.enforce(from('203.0.113.1'), T0));

    const ceiling = createPasswordResetGuard({ windowMs: 60_000, perAddress: 99, total: 1 });
    ceiling.enforce(from('203.0.113.1'), T0);
    const everyones = captureMessage(() => ceiling.enforce(from('198.51.100.9'), T0));

    expect(mine).toBe(everyones);
  });

  it('puts every caller in one bucket when nothing said who they are', () => {
    const guard = createPasswordResetGuard(limits);

    guard.enforce(from(), T0);
    guard.enforce(from(), T0);
    expect(() => guard.enforce(from(), T0)).toThrowError();
    expect(UNKNOWN_ADDRESS_KEY.length).toBeGreaterThan(0);
  });

  it('frees the budget when the window passes', () => {
    const guard = createPasswordResetGuard(limits);

    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    expect(() => guard.enforce(from('203.0.113.1'), T0 + limits.windowMs + 1)).not.toThrow();
  });
});

describe('the configured limits', () => {
  it('defaults to more links than a person can use, and a ceiling nobody honest approaches', () => {
    expect(readPasswordResetLimits({})).toEqual(DEFAULT_PASSWORD_RESET_LIMITS);
    // The service sends at most one message a minute per account, so a per-caller budget of a few
    // in a quarter hour is already past what a real person can act on.
    expect(DEFAULT_PASSWORD_RESET_LIMITS.perAddress).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_PASSWORD_RESET_LIMITS.total).toBeGreaterThan(
      DEFAULT_PASSWORD_RESET_LIMITS.perAddress,
    );
  });

  it('reads all three settings', () => {
    expect(
      readPasswordResetLimits({
        RESET_RATE_LIMIT_WINDOW_SECONDS: '30',
        RESET_RATE_LIMIT_PER_IP: '4',
        RESET_RATE_LIMIT_TOTAL: '40',
      }),
    ).toEqual({ windowMs: 30_000, perAddress: 4, total: 40 });
  });

  it.each([
    ['not a number', { RESET_RATE_LIMIT_PER_IP: 'lots' }],
    ['zero', { RESET_RATE_LIMIT_PER_IP: '0' }],
    ['negative', { RESET_RATE_LIMIT_TOTAL: '-5' }],
  ])('refuses a setting that is %s, naming the variable', (_label, env) => {
    expect(() => readPasswordResetLimits(env)).toThrowError(/RESET_RATE_LIMIT/);
  });

  it('refuses a ceiling below the per-caller budget, which would refuse one caller early', () => {
    expect(() =>
      readPasswordResetLimits({ RESET_RATE_LIMIT_PER_IP: '50', RESET_RATE_LIMIT_TOTAL: '10' }),
    ).toThrowError(/below/);
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
