import { ApiError } from '@/server/api/errors';
import {
  describeWait,
  readBudgetCount,
  retryAfterSeconds,
  type EnvSource,
} from '@/server/api/budgets';
import { clientAddress } from '@/server/api/client-address';
import { createRateLimiter, type RateLimiter } from '@/server/api/rate-limit';
import { logger } from '@/server/observability/logger';

/**
 * The budget on asking for an account-deletion link ([3.1.8](docs/project/prd.md)).
 *
 * The password-reset budget's shape and the password-reset budget's argument
 * (`server/password-reset/limits.ts`), because the exposure is identical: an unauthenticated
 * route that, for an address with an account, sends mail. The service bounds what one *account*
 * can be sent — one live request, a minute between messages — and that is blind to a caller who
 * works through many addresses; two budgets, one per caller and one across the route, are what
 * see it. The enumeration rule holds the same way: a refusal is an answer about the caller's
 * request count, never about the address in the body.
 *
 * Its own counters and its own variables rather than a share of the reset's, because the two
 * routes are different things to spend: a member who asked for three reset links should not find
 * the deletion page closed, and an operator tuning one should not move the other.
 *
 * **This is one process's count.** See `rate-limit.ts`: the web app runs as a single forked pm2
 * instance, which is what makes an in-memory count the true count.
 */

export interface AccountDeletionLimits {
  readonly windowMs: number;
  /** Requests one caller may spend in the window. */
  readonly perAddress: number;
  /** Requests every caller together may spend in the window. */
  readonly total: number;
}

/**
 * Fifteen minutes, three per caller, fifty across the route — tighter than the reset's five and
 * a hundred, because the honest case is rarer: a person deletes an account once, and a link that
 * did not arrive is asked for again, not five times. Fifty across the route in a quarter hour is
 * still a rate a hundred-member group never approaches.
 */
export const DEFAULT_ACCOUNT_DELETION_LIMITS: AccountDeletionLimits = {
  windowMs: 15 * 60 * 1000,
  perAddress: 3,
  total: 50,
};

/** How many callers to remember at once. The same reasoning as registration's cap. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** The key every caller shares when nothing in front of the app said who they are. */
export const UNKNOWN_ADDRESS_KEY = 'unknown';

/** The single bucket the whole-route ceiling counts in. Not an address, and cannot collide with one. */
const TOTAL_KEY = 'all';

export function readAccountDeletionLimits(env: EnvSource = process.env): AccountDeletionLimits {
  const windowSeconds = readBudgetCount(
    env,
    'DELETION_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_ACCOUNT_DELETION_LIMITS.windowMs / 1000,
  );
  const perAddress = readBudgetCount(
    env,
    'DELETION_RATE_LIMIT_PER_IP',
    DEFAULT_ACCOUNT_DELETION_LIMITS.perAddress,
  );
  const total = readBudgetCount(
    env,
    'DELETION_RATE_LIMIT_TOTAL',
    DEFAULT_ACCOUNT_DELETION_LIMITS.total,
  );

  if (total < perAddress) {
    throw new Error(
      `DELETION_RATE_LIMIT_TOTAL (${total}) is below DELETION_RATE_LIMIT_PER_IP (${perAddress}), ` +
        'so the ceiling would refuse a single caller before their own budget ran out. Raise the ' +
        'total, or lower the per-caller limit.',
    );
  }
  return { windowMs: windowSeconds * 1000, perAddress, total };
}

export interface AccountDeletionGuard {
  /** Spend one request, or throw the refusal the caller is owed. */
  readonly enforce: (request: Request, now?: number) => void;
}

/** A factory over its own counters, so a test can hold one nothing else has spent from. */
export function createAccountDeletionGuard(
  limits: AccountDeletionLimits = readAccountDeletionLimits(),
): AccountDeletionGuard {
  const perAddress: RateLimiter = createRateLimiter({
    limit: limits.perAddress,
    windowMs: limits.windowMs,
    maxKeys: MAX_TRACKED_ADDRESSES,
  });
  const total: RateLimiter = createRateLimiter({
    limit: limits.total,
    windowMs: limits.windowMs,
    // One key, ever, so this counter cannot be evicted by traffic — the property that makes it a
    // backstop.
    maxKeys: 1,
  });

  let warnedAboutUnknown = false;

  function enforce(request: Request, now: number = Date.now()): void {
    const address = clientAddress(request);
    if (address === null && !warnedAboutUnknown) {
      warnedAboutUnknown = true;
      logger.warn('account-deletion.rate-limit.no-client-address', {
        action: 'account-deletion.request',
        reason:
          'Neither X-Real-IP nor X-Forwarded-For was set, so every caller shares one budget. ' +
          'Check the reverse proxy — see deploy/nginx/thp.conf.',
      });
    }

    const key = address ?? UNKNOWN_ADDRESS_KEY;
    const mine = perAddress.spend(key, now);
    if (!mine.allowed) {
      logger.warn('account-deletion.rate-limited', {
        action: 'account-deletion.request',
        target: `address:${key}`,
        reason: 'per-address-budget-spent',
        spent: mine.spent,
      });
      throw refusal(mine.retryAfterMs);
    }

    // Only requests that got past their own budget are counted here, so a caller who is already
    // being refused cannot also spend the route's ceiling on everybody else's behalf.
    const everyone = total.spend(TOTAL_KEY, now);
    if (!everyone.allowed) {
      logger.error('account-deletion.rate-limited', {
        action: 'account-deletion.request',
        target: 'route:account-deletion',
        reason: 'whole-route-ceiling-reached',
        spent: everyone.spent,
      });
      throw refusal(everyone.retryAfterMs);
    }
  }

  return { enforce };
}

/** One message for both limits; which budget ran out is in the log and never on the wire. */
function refusal(retryAfterMs: number): ApiError {
  const seconds = retryAfterSeconds(retryAfterMs);
  return ApiError.rateLimited(
    seconds,
    `Too many account-deletion requests. Try again in ${describeWait(seconds)}.`,
  );
}

let shared: AccountDeletionGuard | undefined;

/** The guard the route uses: one per process, built on first use so a bad setting fails one route. */
export function accountDeletionGuard(): AccountDeletionGuard {
  shared ??= createAccountDeletionGuard();
  return shared;
}
