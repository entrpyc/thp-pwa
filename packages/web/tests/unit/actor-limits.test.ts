import { describe, expect, it } from 'vitest';
import {
  ACTOR_BUDGETS,
  ACTOR_BUDGET_KINDS,
  createActorGuard,
  type ActorBudgetKind,
} from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';

/**
 * The per-account budgets (docs/project/prd.md, 3.1.22), driven with an injected clock.
 *
 * The limiter's arithmetic is proved in `rate-limit.test.ts`; what this file pins is the shape on
 * top of it — one counter per kind, keyed by account, with a refusal that names the wait. The
 * integration suite proves each guard sits in the right place in its service.
 */

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const alice = { id: 'account-alice' };
const bob = { id: 'account-bob' };

/** Every kind at two per minute, so a test can drive a refusal in three lines. */
const tight = Object.fromEntries(
  ACTOR_BUDGET_KINDS.map((kind) => [
    kind,
    { limit: 2, windowMs: MINUTE, refusal: ACTOR_BUDGETS[kind].refusal },
  ]),
) as Record<ActorBudgetKind, { limit: number; windowMs: number; refusal: string }>;

describe('the per-account budgets', () => {
  it('refuse with 429, a rate_limited code and a Retry-After header', () => {
    const guard = createActorGuard(tight);

    guard.spend('feedback', alice, T0);
    guard.spend('feedback', alice, T0);

    try {
      guard.spend('feedback', alice, T0);
      expect.unreachable('the third report should have been refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      const error = caught as ApiError;
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      expect(error.headers['retry-after']).toBe('60');
      expect(error.message).toContain(ACTOR_BUDGETS.feedback.refusal);
      expect(error.message).toContain('1 minute');
    }
  });

  it('are keyed by account: one member spent is not another member spent', () => {
    const guard = createActorGuard(tight);

    guard.spend('avatar-grant', alice, T0);
    guard.spend('avatar-grant', alice, T0);
    expect(() => guard.spend('avatar-grant', alice, T0)).toThrowError();
    expect(() => guard.spend('avatar-grant', bob, T0)).not.toThrow();
  });

  it('are one counter per kind: an admin’s recordings do not spend their avatar', () => {
    const guard = createActorGuard(tight);

    guard.spend('recording-grant', alice, T0);
    guard.spend('recording-grant', alice, T0);
    expect(() => guard.spend('recording-grant', alice, T0)).toThrowError();

    for (const other of ACTOR_BUDGET_KINDS.filter((kind) => kind !== 'recording-grant')) {
      expect(() => guard.spend(other, alice, T0)).not.toThrow();
    }
  });

  it('say which budget it was, because the caller is the person who spent it', () => {
    // Unlike the unauthenticated budgets, there is nobody here to hide the answer from: the
    // account being refused is the account that did the spending.
    const guard = createActorGuard(tight);
    guard.spend('feedback', alice, T0);
    guard.spend('feedback', alice, T0);
    expect(() => guard.spend('feedback', alice, T0)).toThrowError(/reports in the last hour/);

    guard.spend('artwork-grant', alice, T0);
    guard.spend('artwork-grant', alice, T0);
    expect(() => guard.spend('artwork-grant', alice, T0)).toThrowError(/upload attempts/);
  });

  it('free the budget when the window passes', () => {
    const guard = createActorGuard(tight);

    guard.spend('feedback', alice, T0);
    guard.spend('feedback', alice, T0);
    expect(() => guard.spend('feedback', alice, T0)).toThrowError();
    expect(() => guard.spend('feedback', alice, T0 + MINUTE + 1)).not.toThrow();
  });
});

describe('the shipped numbers', () => {
  it('cover every kind, per hour, at rates no honest use reaches', () => {
    for (const kind of ACTOR_BUDGET_KINDS) {
      const budget = ACTOR_BUDGETS[kind];
      expect(budget.windowMs).toBe(60 * 60 * 1000);
      expect(budget.limit).toBeGreaterThanOrEqual(10);
      expect(budget.refusal.length).toBeGreaterThan(0);
    }
    // The bulk path an admin actually uses gets more room than a member's picture.
    expect(ACTOR_BUDGETS['recording-grant'].limit).toBeGreaterThan(
      ACTOR_BUDGETS['avatar-grant'].limit,
    );
  });

  it('build a guard from the shipped numbers without being handed any', () => {
    const guard = createActorGuard();
    for (let n = 0; n < ACTOR_BUDGETS.feedback.limit; n += 1) guard.spend('feedback', alice, T0);
    expect(() => guard.spend('feedback', alice, T0)).toThrowError();
  });
});
