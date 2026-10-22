import { describe, expect, it } from 'vitest';
import { ApiError } from '@/server/api/errors';
import {
  DEFAULT_ACCOUNT_DELETION_LIMITS,
  createAccountDeletionGuard,
  readAccountDeletionLimits,
} from '@/server/account-deletion/limits';

/**
 * The deletion-request budget's policy, driven with an injected clock. The reset budget's tests,
 * one flow over: the limiter's arithmetic is proved in `rate-limit.test.ts`, and what this pins is
 * that the two budgets sit in front of this route in the same order with the same rules.
 */

const T0 = 1_700_000_000_000;

const from = (address?: string) =>
  new Request('https://example.test/api/v1/auth/account-deletion', {
    method: 'POST',
    headers: address === undefined ? {} : { 'x-real-ip': address },
  });

const limits = { windowMs: 60_000, perAddress: 2, total: 3 };

describe('the deletion-request budget', () => {
  it('refuses with 429, a rate_limited code and a Retry-After header', () => {
    const guard = createAccountDeletionGuard(limits);
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
      expect(error.message).toContain('Too many account-deletion requests');
    }
  });

  it('leaves a different caller alone, and closes the route once the ceiling is reached', () => {
    const guard = createAccountDeletionGuard(limits);
    guard.enforce(from('203.0.113.1'), T0);
    guard.enforce(from('203.0.113.1'), T0);
    expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
    // The ceiling is three in total, and three have been spent: a caller who spent nothing is refused.
    expect(() => guard.enforce(from('192.0.2.5'), T0)).toThrowError();
  });

  it('does not let a caller over their own budget spend the route ceiling as well', () => {
    const guard = createAccountDeletionGuard({ windowMs: 60_000, perAddress: 1, total: 2 });
    guard.enforce(from('203.0.113.1'), T0);
    for (let n = 0; n < 4; n += 1) {
      expect(() => guard.enforce(from('203.0.113.1'), T0)).toThrowError();
    }
    expect(() => guard.enforce(from('198.51.100.9'), T0)).not.toThrow();
  });

  it('puts every caller in one bucket when nothing said who they are', () => {
    const guard = createAccountDeletionGuard(limits);
    guard.enforce(from(), T0);
    guard.enforce(from(), T0);
    expect(() => guard.enforce(from(), T0)).toThrowError();
  });
});

describe('reading the limits', () => {
  it('defaults to three per caller and fifty across the route in a quarter hour', () => {
    expect(readAccountDeletionLimits({})).toEqual(DEFAULT_ACCOUNT_DELETION_LIMITS);
    expect(DEFAULT_ACCOUNT_DELETION_LIMITS).toEqual({
      windowMs: 15 * 60 * 1000,
      perAddress: 3,
      total: 50,
    });
  });

  it('reads its own variables, and refuses a total below the per-caller limit by name', () => {
    expect(
      readAccountDeletionLimits({
        DELETION_RATE_LIMIT_WINDOW_SECONDS: '60',
        DELETION_RATE_LIMIT_PER_IP: '4',
        DELETION_RATE_LIMIT_TOTAL: '8',
      }),
    ).toEqual({ windowMs: 60_000, perAddress: 4, total: 8 });
    expect(() =>
      readAccountDeletionLimits({ DELETION_RATE_LIMIT_PER_IP: '5', DELETION_RATE_LIMIT_TOTAL: '2' }),
    ).toThrowError(/DELETION_RATE_LIMIT_TOTAL/);
  });
});
