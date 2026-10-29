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
 * The budget on **presenting a mailed token** — the password-reset, account-deletion and
 * invitation links, both the preview a screen makes on load and the completion that spends the
 * token (docs/security-audit-2026-10-28.md, finding 13).
 *
 * The tokens themselves are 256 random bits, so guessing one is not the attack this bounds. The
 * attack is what a caller can do *with* a link they hold: account-deletion completion checks the
 * account's current password after the token, so an unbounded route is an argon2 password oracle
 * for an hour to whoever intercepted the message. Every other token route is bounded for the same
 * price, because a preview that answers "expired" or "for this address" as fast as a script can
 * ask is a cost the box pays for nothing.
 *
 * **One budget, per caller.** No route-wide ceiling: unlike the request routes next door, nothing
 * here sends a message or creates a row an admin has to clean up, so a distributed flood costs the
 * box CPU and nothing else — and a ceiling here would let that flood close every reset and
 * invitation link in flight for everybody, which is a worse outcome than the CPU.
 *
 * **Thirty in a quarter hour** is a person opening a link, mistyping a password twice, opening the
 * link again on their phone, and still having most of the budget left. It is one three-hundredth
 * of what an argon2 oracle needs to be worth running.
 *
 * Same process-local limiter as registration (`rate-limit.ts`); same reason it is the true count.
 */

export interface TokenLimits {
  readonly windowMs: number;
  /** Requests one caller may spend in the window, across every token route together. */
  readonly perAddress: number;
}

export const DEFAULT_TOKEN_LIMITS: TokenLimits = {
  windowMs: 15 * 60 * 1000,
  perAddress: 30,
};

/** How many callers to remember at once. The same reasoning as registration's cap. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** The key every caller shares when nothing in front of the app said who they are. */
export const UNKNOWN_ADDRESS_KEY = 'unknown';

/** The limits in force, from configuration, defaulting to {@link DEFAULT_TOKEN_LIMITS}. */
export function readTokenLimits(env: EnvSource = process.env): TokenLimits {
  const windowSeconds = readBudgetCount(
    env,
    'TOKEN_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_TOKEN_LIMITS.windowMs / 1000,
  );
  const perAddress = readBudgetCount(env, 'TOKEN_RATE_LIMIT_PER_IP', DEFAULT_TOKEN_LIMITS.perAddress);
  return { windowMs: windowSeconds * 1000, perAddress };
}

export interface TokenGuard {
  /** Spend one token presentation, or throw the refusal the caller is owed. */
  readonly enforce: (request: Request, now?: number) => void;
}

/** Build a guard over its own counter, so a test can hold one nothing else has spent from. */
export function createTokenGuard(limits: TokenLimits = readTokenLimits()): TokenGuard {
  const perAddress: RateLimiter = createRateLimiter({
    limit: limits.perAddress,
    windowMs: limits.windowMs,
    maxKeys: MAX_TRACKED_ADDRESSES,
  });

  /** Warned about once per process, not once per request: it is a deployment fact, not an event. */
  let warnedAboutUnknown = false;

  function enforce(request: Request, now: number = Date.now()): void {
    const address = clientAddress(request);
    if (address === null && !warnedAboutUnknown) {
      warnedAboutUnknown = true;
      logger.warn('token.rate-limit.no-client-address', {
        action: 'token',
        reason:
          'Neither X-Real-IP nor X-Forwarded-For was set, so every caller shares one budget. ' +
          'Check the reverse proxy — see deploy/nginx/thp.conf.',
      });
    }

    const key = address ?? UNKNOWN_ADDRESS_KEY;
    const mine = perAddress.spend(key, now);
    if (!mine.allowed) {
      logger.warn('token.rate-limited', {
        action: 'token',
        target: `address:${key}`,
        reason: 'per-address-budget-spent',
        spent: mine.spent,
      });
      const seconds = retryAfterSeconds(mine.retryAfterMs);
      throw ApiError.rateLimited(
        seconds,
        `Too many attempts with this link. Try again in ${describeWait(seconds)}.`,
      );
    }
  }

  return { enforce };
}

let shared: TokenGuard | undefined;

/** The one guard the token routes share: a reset preview and an invitation accept draw on one budget. */
export function tokenGuard(): TokenGuard {
  shared ??= createTokenGuard();
  return shared;
}
