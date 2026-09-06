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
 * The budget on asking for a reset link (docs/project/prd.md, 3.1.21;
 * docs/project/rate-limits.md § 2.2).
 *
 * A reset request is unauthenticated by definition and, for an address that has an account, it
 * sends mail. The service already bounds what one *account* can be sent — one live reset, and a
 * second request inside a minute sends nothing (3.1.6) — but that bound is per account, and it is
 * blind to a caller who works through many addresses: each one is that account's first request in
 * a minute, and each one is a message a member did not ask for. Two budgets, because those are two
 * different attacks, and they are the same two registration holds (3.1.18):
 *
 * 1. **Per caller.** Stops one machine from doing it.
 * 2. **Across the whole route.** Stops the same thing done from many addresses at once, which
 *    the per-caller budget cannot see at all — every request looks like somebody's first.
 *
 * **The enumeration rule still holds.** The route answers one fixed payload for every outcome so
 * that it cannot say whether an address is a member. A refusal is a different answer, but it is an
 * answer about the *caller* — how many requests they have made — and says nothing about the address
 * in the body, so nothing 3.1.6 keeps quiet is disclosed. What the budget does change is the size
 * of the sample an attacker can take of the one thing the fixed payload cannot hide: the time a
 * request takes when mail is sent versus when it is not.
 *
 * **The whole-route ceiling is a trade, stated rather than hidden.** While it is spent, nobody can
 * ask for a reset, real people included. That is accepted for the same reason registration accepts
 * it: a quarter hour of "try again later" is recoverable, and a hundred members each mailed a link
 * they did not ask for is a support incident and a phishing rehearsal. It is logged at `error`
 * rather than `warn` because reaching it is an event an operator should be looking at.
 *
 * **Checked before the body is read**, as registration's is: a refused caller has cost the server a
 * header lookup and nothing else.
 *
 * **This is one process's count.** See `rate-limit.ts`: the web app runs as a single forked pm2
 * instance, which is what makes an in-memory count the true count.
 */

export interface PasswordResetLimits {
  readonly windowMs: number;
  /** Requests one caller may spend in the window. */
  readonly perAddress: number;
  /** Requests every caller together may spend in the window. */
  readonly total: number;
}

/**
 * Fifteen minutes, five per caller, a hundred across the route.
 *
 * Five is generous for somebody who genuinely cannot remember: the service sends at most one
 * message a minute per account, so five requests in a quarter hour is already more links than a
 * person can use. A hundred across the route in a quarter hour is four hundred an hour — a rate a
 * hundred-member group reaches on no day that has ever happened, and one that makes mailing the
 * whole member list a slow enough job to be noticed.
 */
export const DEFAULT_PASSWORD_RESET_LIMITS: PasswordResetLimits = {
  windowMs: 15 * 60 * 1000,
  perAddress: 5,
  total: 100,
};

/** How many callers to remember at once. The same reasoning as registration's cap. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** The key every caller shares when nothing in front of the app said who they are. */
export const UNKNOWN_ADDRESS_KEY = 'unknown';

/** The single bucket the whole-route ceiling counts in. Not an address, and cannot collide with one. */
const TOTAL_KEY = 'all';

/**
 * The limits in force, from configuration, defaulting to {@link DEFAULT_PASSWORD_RESET_LIMITS}.
 *
 * Configurable for the reason registration's are: how many members sit behind one address is a
 * fact about a congregation, not about the software.
 */
export function readPasswordResetLimits(env: EnvSource = process.env): PasswordResetLimits {
  const windowSeconds = readBudgetCount(
    env,
    'RESET_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_PASSWORD_RESET_LIMITS.windowMs / 1000,
  );
  const perAddress = readBudgetCount(
    env,
    'RESET_RATE_LIMIT_PER_IP',
    DEFAULT_PASSWORD_RESET_LIMITS.perAddress,
  );
  const total = readBudgetCount(env, 'RESET_RATE_LIMIT_TOTAL', DEFAULT_PASSWORD_RESET_LIMITS.total);

  if (total < perAddress) {
    throw new Error(
      `RESET_RATE_LIMIT_TOTAL (${total}) is below RESET_RATE_LIMIT_PER_IP (${perAddress}), so ` +
        'the ceiling would refuse a single caller before their own budget ran out. Raise the ' +
        'total, or lower the per-caller limit.',
    );
  }
  return { windowMs: windowSeconds * 1000, perAddress, total };
}

export interface PasswordResetGuard {
  /** Spend one reset request, or throw the refusal the caller is owed. */
  readonly enforce: (request: Request, now?: number) => void;
}

/**
 * Build a guard over its own counters.
 *
 * A factory rather than a module-level pair of limiters so a test can hold one that nothing else
 * has spent from — and so the two counters are visibly created together.
 */
export function createPasswordResetGuard(
  limits: PasswordResetLimits = readPasswordResetLimits(),
): PasswordResetGuard {
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

  /** Warned about once per process, not once per request: it is a deployment fact, not an event. */
  let warnedAboutUnknown = false;

  function enforce(request: Request, now: number = Date.now()): void {
    const address = clientAddress(request);
    if (address === null && !warnedAboutUnknown) {
      warnedAboutUnknown = true;
      logger.warn('password-reset.rate-limit.no-client-address', {
        action: 'password-reset',
        reason:
          'Neither X-Real-IP nor X-Forwarded-For was set, so every caller shares one budget. ' +
          'Check the reverse proxy — see deploy/nginx/thp.conf.',
      });
    }

    const key = address ?? UNKNOWN_ADDRESS_KEY;
    const mine = perAddress.spend(key, now);
    if (!mine.allowed) {
      logger.warn('password-reset.rate-limited', {
        action: 'password-reset',
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
      logger.error('password-reset.rate-limited', {
        action: 'password-reset',
        target: 'route:password-reset',
        reason: 'whole-route-ceiling-reached',
        spent: everyone.spent,
      });
      throw refusal(everyone.retryAfterMs);
    }
  }

  return { enforce };
}

/**
 * **One message for both limits.** Which budget ran out is in the log and never on the wire, for
 * the reason registration gives: "you personally are blocked" versus "everyone is" says whether an
 * attacker is alone.
 */
function refusal(retryAfterMs: number): ApiError {
  const seconds = retryAfterSeconds(retryAfterMs);
  return ApiError.rateLimited(
    seconds,
    `Too many password-reset requests. Try again in ${describeWait(seconds)}.`,
  );
}

/**
 * The guard the route uses: one per process, built on first use.
 *
 * Lazy rather than built at import, because reading configuration is a thing that can throw and a
 * module that throws while being imported takes down every route in the bundle, not just this one.
 */
let shared: PasswordResetGuard | undefined;

export function passwordResetGuard(): PasswordResetGuard {
  shared ??= createPasswordResetGuard();
  return shared;
}
