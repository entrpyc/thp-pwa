import { ApiError } from '@/server/api/errors';
import { clientAddress } from '@/server/api/client-address';
import { createRateLimiter, type RateLimiter } from '@/server/api/rate-limit';
import { logger } from '@/server/observability/logger';

/**
 * The budget on registering (docs/project/prd.md, 3.1.18).
 *
 * Sign-up is the only unauthenticated route in the product that **writes**, and the only one that
 * answers an anonymous caller with a fact about somebody else's account — that an address is taken
 * (3.1.17). Both of those are bounded here, and it takes two limits because they are two different
 * attacks that a single number cannot separate:
 *
 * 1. **Per caller.** Stops one machine from working through a list of addresses to learn who is a
 *    member, and from filling the member list with accounts nobody asked for.
 * 2. **Across the whole route.** Stops the same thing done from many addresses at once, which the
 *    per-caller limit cannot see at all — every request looks like somebody's first.
 *
 * **The numbers are deliberately generous, and the reason is a real Sunday.** This is a private
 * ministry group of about a hundred people. The registration burst this product should expect is a
 * room of members on one wifi, told to sign up now, several of them mistyping a password first —
 * and a limit that refuses the twentieth person in that room has broken the product to prevent
 * something an admin would have noticed within the hour. So the per-caller budget is set well above
 * any honest burst and still far below what bulk probing needs, and the ceiling is set at a rate
 * nothing legitimate approaches.
 *
 * **The whole-route ceiling is a trade, stated rather than hidden.** While it is spent, registration
 * is closed to everybody, including real people — a distributed flood can therefore deny sign-up
 * for as long as it keeps paying for it. That is accepted on purpose: a few hours of "try again
 * later" is recoverable, and ten thousand junk accounts in the member list is not. It is logged at
 * `error` rather than `warn` for exactly that reason — reaching it is an event an operator should
 * be looking at, not a line in a pile of refusals.
 *
 * **This is one process's count.** See `rate-limit.ts`: the web app runs as a single forked pm2
 * instance, which is what makes an in-memory count the true count. Cluster mode would multiply
 * every number here by the instance count without changing a line of this file.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface SignUpLimits {
  readonly windowMs: number;
  /** Requests one caller may spend in the window. */
  readonly perAddress: number;
  /** Requests every caller together may spend in the window. */
  readonly total: number;
}

/**
 * Ten minutes, twenty per caller, two hundred across the route.
 *
 * Twenty is roughly "a room of people signing up together, with retries". Two hundred in ten
 * minutes is twelve hundred an hour — a rate a hundred-member group reaches on no day that has
 * ever happened, and one that makes bulk registration pointlessly slow.
 */
export const DEFAULT_SIGN_UP_LIMITS: SignUpLimits = {
  windowMs: 10 * 60 * 1000,
  perAddress: 20,
  total: 200,
};

/**
 * How many callers to remember at once.
 *
 * Ten thousand entries of a short string and at most twenty numbers is a few megabytes at the very
 * worst, which is affordable on the four-vCPU box this runs on; and ten thousand distinct addresses
 * inside ten minutes is already far past the ceiling above, so in practice the cap is reached only
 * by something the ceiling has already refused.
 */
const MAX_TRACKED_ADDRESSES = 10_000;

/** The key every caller shares when nothing in front of the app said who they are. */
export const UNKNOWN_ADDRESS_KEY = 'unknown';

/** The single bucket the whole-route ceiling counts in. Not an address, and cannot collide with one. */
const TOTAL_KEY = 'all';

function readCount(env: EnvSource, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} is "${raw}", which is not a positive whole number. See .env.example.`);
  }
  return parsed;
}

/**
 * The limits in force, from configuration, defaulting to {@link DEFAULT_SIGN_UP_LIMITS}.
 *
 * Configurable rather than constant — unlike the invitation and reset windows next door — because
 * the right number here depends on something the code cannot know: how many people sit behind one
 * address at this deployment. It is also what lets the integration suite start a server with a
 * budget of three and drive the refusal for real, instead of asserting that a constant exists.
 */
export function readSignUpLimits(env: EnvSource = process.env): SignUpLimits {
  const windowSeconds = readCount(
    env,
    'SIGNUP_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_SIGN_UP_LIMITS.windowMs / 1000,
  );
  const perAddress = readCount(env, 'SIGNUP_RATE_LIMIT_PER_IP', DEFAULT_SIGN_UP_LIMITS.perAddress);
  const total = readCount(env, 'SIGNUP_RATE_LIMIT_TOTAL', DEFAULT_SIGN_UP_LIMITS.total);

  if (total < perAddress) {
    throw new Error(
      `SIGNUP_RATE_LIMIT_TOTAL (${total}) is below SIGNUP_RATE_LIMIT_PER_IP (${perAddress}), so ` +
        'the ceiling would refuse a single caller before their own budget ran out. Raise the ' +
        'total, or lower the per-caller limit.',
    );
  }
  return { windowMs: windowSeconds * 1000, perAddress, total };
}

export interface SignUpGuard {
  /** Spend one registration attempt, or throw the refusal the caller is owed. */
  readonly enforce: (request: Request, now?: number) => void;
}

/**
 * Build a guard over its own counters.
 *
 * A factory rather than a module-level pair of limiters so a test can hold one that nothing else
 * has spent from — and so the two counters are visibly created together, which is the thing that
 * makes "one of these is per caller and one is not" readable.
 */
export function createSignUpGuard(limits: SignUpLimits = readSignUpLimits()): SignUpGuard {
  const perAddress: RateLimiter = createRateLimiter({
    limit: limits.perAddress,
    windowMs: limits.windowMs,
    maxKeys: MAX_TRACKED_ADDRESSES,
  });
  const total: RateLimiter = createRateLimiter({
    limit: limits.total,
    windowMs: limits.windowMs,
    // One key, ever. Named rather than left at a default so it is obvious this counter cannot be
    // evicted by traffic — which is the property that makes it a backstop.
    maxKeys: 1,
  });

  /** Warned about once per process, not once per request: it is a deployment fact, not an event. */
  let warnedAboutUnknown = false;

  function enforce(request: Request, now: number = Date.now()): void {
    const address = clientAddress(request);
    if (address === null && !warnedAboutUnknown) {
      warnedAboutUnknown = true;
      logger.warn('signup.rate-limit.no-client-address', {
        action: 'signup',
        reason:
          'Neither X-Real-IP nor X-Forwarded-For was set, so every caller shares one budget. ' +
          'Check the reverse proxy — see deploy/nginx/thp.conf.',
      });
    }

    const key = address ?? UNKNOWN_ADDRESS_KEY;
    const mine = perAddress.spend(key, now);
    if (!mine.allowed) {
      logger.warn('signup.rate-limited', {
        action: 'signup',
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
      logger.error('signup.rate-limited', {
        action: 'signup',
        target: 'route:sign-up',
        reason: 'whole-route-ceiling-reached',
        spent: everyone.spent,
      });
      throw refusal(everyone.retryAfterMs);
    }
  }

  return { enforce };
}

/**
 * **One message for both limits.** Which budget ran out is in the log and never on the wire: told
 * apart, the two answers say whether an attacker is alone, and "you personally are blocked" versus
 * "everyone is" is a reconnaissance signal worth more than it is worth spending a sentence on.
 */
function refusal(retryAfterMs: number): ApiError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return ApiError.rateLimited(
    seconds,
    `Too many sign-up attempts. Try again in ${describeWait(seconds)}.`,
  );
}

/** A wait a person can act on. Nobody reads "in 437 seconds" and does anything different. */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The guard the route uses: one per process, built on first use.
 *
 * Lazy rather than built at import, because reading configuration is a thing that can throw and a
 * module that throws while being imported takes down every route in the bundle, not just this one.
 */
let shared: SignUpGuard | undefined;

export function signUpGuard(): SignUpGuard {
  shared ??= createSignUpGuard();
  return shared;
}
