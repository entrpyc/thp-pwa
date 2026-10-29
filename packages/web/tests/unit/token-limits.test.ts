import { describe, expect, it } from 'vitest';
import { ApiError } from '@/server/api/errors';
import {
  DEFAULT_TOKEN_LIMITS,
  UNKNOWN_ADDRESS_KEY,
  createTokenGuard,
  readTokenLimits,
} from '@/server/auth/token-limits';

/**
 * The token-presentation budget (security audit, finding 13), driven with an injected clock. The
 * limiter's arithmetic is proved in `rate-limit.test.ts`; this pins the policy on top of it: one
 * per-caller budget shared by every token route, no route-wide ceiling, and a refusal shaped like
 * every other 429 in the product.
 */

const T0 = 1_700_000_000_000;

const from = (path: string, address?: string) =>
  new Request(`https://example.test/api/v1/auth/${path}`, {
    method: 'POST',
    headers: address === undefined ? {} : { 'x-real-ip': address },
  });

const limits = { windowMs: 60_000, perAddress: 2 };

describe('the token-presentation budget', () => {
  it('refuses the request over budget with 429, rate_limited and a Retry-After', () => {
    const guard = createTokenGuard(limits);
    guard.enforce(from('password-reset/complete', '203.0.113.1'), T0);
    guard.enforce(from('account-deletion/complete', '203.0.113.1'), T0);
    try {
      guard.enforce(from('invitations/accept', '203.0.113.1'), T0);
      expect.unreachable('the third request should have been refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      const error = caught as ApiError;
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      expect(error.headers['retry-after']).toBe('60');
    }
  });

  it('is one budget across the token routes, not one per route', () => {
    const guard = createTokenGuard(limits);
    guard.enforce(from('password-reset', '203.0.113.1'), T0);
    guard.enforce(from('invitations/accept', '203.0.113.1'), T0);
    expect(() => guard.enforce(from('account-deletion', '203.0.113.1'), T0)).toThrow(ApiError);
  });

  it('keeps callers apart, and has no ceiling that one caller can close for another', () => {
    const guard = createTokenGuard(limits);
    for (const address of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) {
      guard.enforce(from('password-reset', address), T0);
      guard.enforce(from('password-reset', address), T0);
    }
    expect(() => guard.enforce(from('password-reset', '203.0.113.5'), T0)).not.toThrow();
    expect(() => guard.enforce(from('password-reset', '203.0.113.1'), T0)).toThrow(ApiError);
  });

  it('opens the budget again once the window has passed', () => {
    const guard = createTokenGuard(limits);
    guard.enforce(from('password-reset', '203.0.113.1'), T0);
    guard.enforce(from('password-reset', '203.0.113.1'), T0);
    expect(() => guard.enforce(from('password-reset', '203.0.113.1'), T0 + 60_000)).not.toThrow();
  });

  it('pools callers with no address under one key', () => {
    const guard = createTokenGuard(limits);
    guard.enforce(from('password-reset'), T0);
    guard.enforce(from('password-reset'), T0);
    expect(UNKNOWN_ADDRESS_KEY).toBe('unknown');
    expect(() => guard.enforce(from('password-reset'), T0)).toThrow(ApiError);
  });

  it('reads its limits from the environment, with defaults', () => {
    expect(readTokenLimits({})).toEqual(DEFAULT_TOKEN_LIMITS);
    expect(
      readTokenLimits({ TOKEN_RATE_LIMIT_WINDOW_SECONDS: '60', TOKEN_RATE_LIMIT_PER_IP: '7' }),
    ).toEqual({ windowMs: 60_000, perAddress: 7 });
  });
});
