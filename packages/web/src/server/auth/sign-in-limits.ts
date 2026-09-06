import { normaliseEmail } from '@thp/db';
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
import { hashToken } from './tokens';

/**
 * The budget on signing in (docs/project/prd.md, 3.1.20; docs/project/rate-limits.md § 2.1).
 *
 * Sign-in is unauthenticated by definition and every attempt costs an argon2id verification —
 * around a hundred milliseconds on the deploy box, on purpose, so that a stolen hash is slow to
 * crack. Without a budget that cost is also the attacker's lever: an online guessing run against
 * one member's address is bounded only by how fast the server can verify, and a few dozen
 * concurrent attempts pin every core the database shares. Two budgets, because those are two
 * different attacks:
 *
 * 1. **Per caller.** Stops one machine from spending the server's CPU, whoever it claims to be.
 * 2. **Per account.** Stops a guessing run against one address, however many machines it comes
 *    from — which the per-caller budget cannot see at all, because each machine looks honest.
 *
 * **The account budget is spent whether or not the address has an account.** A budget that only
 * existed for real members would answer "is this address a member?" with whether the eleventh
 * attempt was refused, and sign-in is built not to answer that (3.1.1). The key is a hash of the
 * normalised address, so the limiter's memory and the log hold no address a probe supplied.
 *
 * **Spent before the password is verified.** That ordering is the whole point: a refused attempt
 * costs no argon2 work, and the per-attempt cost that remains is paid only by attempts the budget
 * allowed. A caller refused by their own address budget does not spend the account's either, so
 * a machine that is already blocked cannot lock a real member out of their own account by
 * continuing to knock.
 *
 * **No lockout.** Nothing is written to the account, nothing needs an admin to clear it, and the
 * window expires by itself. A limit that needed a person to reset it would be a way to lock
 * members out on purpose, and a flag on the row would be one more thing to enumerate.
 *
 * **This is one process's count.** See `rate-limit.ts`: the web app runs as a single forked pm2
 * instance, which is what makes an in-memory count the true count.
 */

export interface SignInLimits {
  readonly windowMs: number;
  /** Attempts one caller may spend in the window, whichever accounts they name. */
  readonly perAddress: number;
  /** Attempts one account may receive in the window, whoever sends them. */
  readonly perAccount: number;
}

/**
 * Fifteen minutes, fifty per caller, ten per account.
 *
 * Ten wrong tries on one account in a quarter hour is past any honest person; fifty per address
 * still lets a room of members on one wifi sign in together, several of them mistyping first. A
 * member who knows their password never reaches either number.
 */
export const DEFAULT_SIGN_IN_LIMITS: SignInLimits = {
  windowMs: 15 * 60 * 1000,
  perAddress: 50,
  perAccount: 10,
};

/** How many callers to remember at once. The same reasoning as registration's cap. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * How many accounts to remember at once. Ten thousand is a hundred times the membership; a
 * guessing run that names more distinct addresses than that inside one window is refused by the
 * address budget long before the cap matters, unless it is distributed — and a distributed run
 * evicting its own targets into fresh budgets is exactly what the limiter's "hammered keys stay
 * fresh" rule prevents.
 */
const MAX_TRACKED_ACCOUNTS = 10_000;

/** The key every caller shares when nothing in front of the app said who they are. */
export const UNKNOWN_ADDRESS_KEY = 'unknown';

/**
 * The limits in force, from configuration, defaulting to {@link DEFAULT_SIGN_IN_LIMITS}.
 *
 * Configurable for the reason registration's are: how many members sit behind one address is a
 * fact about a congregation, not about the software. The account budget is not a fact about the
 * deployment, but it is read from the same place so the two numbers are set and reviewed
 * together.
 */
export function readSignInLimits(env: EnvSource = process.env): SignInLimits {
  const windowSeconds = readBudgetCount(
    env,
    'SIGNIN_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_SIGN_IN_LIMITS.windowMs / 1000,
  );
  const perAddress = readBudgetCount(
    env,
    'SIGNIN_RATE_LIMIT_PER_IP',
    DEFAULT_SIGN_IN_LIMITS.perAddress,
  );
  const perAccount = readBudgetCount(
    env,
    'SIGNIN_RATE_LIMIT_PER_ACCOUNT',
    DEFAULT_SIGN_IN_LIMITS.perAccount,
  );

  // The account budget is the tighter of the two by design — it is the one that stops a guessing
  // run, and the address budget is the wider net around it. A configuration with the order
  // inverted is almost certainly the two variables swapped, and a swap here is silent: nothing
  // would fail, the product would just refuse a wifi full of members at ten and let a guessing run
  // have fifty.
  if (perAccount > perAddress) {
    throw new Error(
      `SIGNIN_RATE_LIMIT_PER_ACCOUNT (${perAccount}) is above SIGNIN_RATE_LIMIT_PER_IP ` +
        `(${perAddress}). The account budget is meant to be the tighter one; check that the two ` +
        'are not swapped.',
    );
  }
  return { windowMs: windowSeconds * 1000, perAddress, perAccount };
}

export interface SignInGuard {
  /**
   * Spend one sign-in attempt, or throw the refusal the caller is owed.
   *
   * `email` is whatever the body carried, or `null` when it carried nothing usable — a malformed
   * body still spends the caller's budget (it is an attempt, and a probe that sends garbage to
   * learn the error shape is still probing) but names no account to spend against.
   */
  readonly enforce: (request: Request, email: string | null, now?: number) => void;
}

/**
 * Build a guard over its own counters.
 *
 * A factory rather than a module-level pair of limiters so a test can hold one that nothing else
 * has spent from — and so the two counters are visibly created together, which is what makes
 * "one of these is per caller and one is per account" readable.
 */
export function createSignInGuard(limits: SignInLimits = readSignInLimits()): SignInGuard {
  const perAddress: RateLimiter = createRateLimiter({
    limit: limits.perAddress,
    windowMs: limits.windowMs,
    maxKeys: MAX_TRACKED_ADDRESSES,
  });
  const perAccount: RateLimiter = createRateLimiter({
    limit: limits.perAccount,
    windowMs: limits.windowMs,
    maxKeys: MAX_TRACKED_ACCOUNTS,
  });

  /** Warned about once per process, not once per request: it is a deployment fact, not an event. */
  let warnedAboutUnknown = false;

  function enforce(request: Request, email: string | null, now: number = Date.now()): void {
    const address = clientAddress(request);
    if (address === null && !warnedAboutUnknown) {
      warnedAboutUnknown = true;
      logger.warn('signin.rate-limit.no-client-address', {
        action: 'signin',
        reason:
          'Neither X-Real-IP nor X-Forwarded-For was set, so every caller shares one budget. ' +
          'Check the reverse proxy — see deploy/nginx/thp.conf.',
      });
    }

    const addressKey = address ?? UNKNOWN_ADDRESS_KEY;
    const mine = perAddress.spend(addressKey, now);
    if (!mine.allowed) {
      logger.warn('signin.rate-limited', {
        action: 'signin',
        target: `address:${addressKey}`,
        reason: 'per-address-budget-spent',
        spent: mine.spent,
      });
      throw refusal(mine.retryAfterMs);
    }

    if (email === null) return;

    // Only attempts that got past their own budget are counted against the account, so a caller
    // who is already being refused cannot spend a member's budget on their behalf.
    const accountKey = accountKeyFor(email);
    const theirs = perAccount.spend(accountKey, now);
    if (!theirs.allowed) {
      logger.warn('signin.rate-limited', {
        action: 'signin',
        target: `account:${accountKey}`,
        reason: 'per-account-budget-spent',
        spent: theirs.spent,
      });
      throw refusal(theirs.retryAfterMs);
    }
  }

  return { enforce };
}

/**
 * The account budget's key: a SHA-256 of the normalised address. Hashed rather than stored so the
 * limiter's memory and the log hold no address a probe supplied, and normalised first so
 * `Alice@Example.test` and `alice@example.test` are one budget — they are one account.
 */
export function accountKeyFor(email: string): string {
  return hashToken(normaliseEmail(email));
}

/**
 * **One message for both budgets.** Which one ran out is in the log and never on the wire: told
 * apart, the two answers say whether an attacker is alone, and "you personally are blocked" versus
 * "this account is" is a reconnaissance signal worth more than it is worth spending a sentence on.
 */
function refusal(retryAfterMs: number): ApiError {
  const seconds = retryAfterSeconds(retryAfterMs);
  return ApiError.rateLimited(
    seconds,
    `Too many sign-in attempts. Try again in ${describeWait(seconds)}.`,
  );
}

/**
 * The guard the route uses: one per process, built on first use.
 *
 * Lazy rather than built at import, because reading configuration is a thing that can throw and a
 * module that throws while being imported takes down every route in the bundle, not just this one.
 */
let shared: SignInGuard | undefined;

export function signInGuard(): SignInGuard {
  shared ??= createSignInGuard();
  return shared;
}

/**
 * The address a sign-in body names, or `null`.
 *
 * Read here rather than through `signIn`'s own parser because the guard has to run *before*
 * anything else does, and the parser's job is to refuse a malformed body with the same answer as a
 * wrong password. This asks one narrower question — is there a string in `email`? — and leaves the
 * rest of the shape to the parser. It is bounded at the same length the parser bounds it at: a
 * hash of a megabyte is still a hash, but it is a megabyte of work the budget was meant to refuse.
 */
export function emailNamedBy(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { email } = body as { email?: unknown };
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  if (trimmed === '' || trimmed.length > MAX_EMAIL_LENGTH) return null;
  return trimmed;
}

/** The same bound `sign-in.ts` puts on a field. */
const MAX_EMAIL_LENGTH = 512;
