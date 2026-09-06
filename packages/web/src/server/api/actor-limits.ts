import { ApiError } from '@/server/api/errors';
import { describeWait, retryAfterSeconds } from '@/server/api/budgets';
import { createRateLimiter, type RateLimiter } from '@/server/api/rate-limit';
import { logger } from '@/server/observability/logger';

/**
 * The budgets a signed-in account holds on the things it can make the product produce
 * (docs/project/prd.md, 3.1.22; docs/project/rate-limits.md § 2.3–2.4).
 *
 * Four routes let any account, or any admin, make the server do something that leaves the server:
 * feedback composes a message and sends it; the three upload grants mint a presigned URL against a
 * store with no delete, so a grant nobody finishes is an orphan forever. None of those is expensive
 * once. All of them are a problem on a loop, and a session is not a reason to trust a loop.
 *
 * **Keyed by account, not by address.** Every caller here is signed in, so the key is always known
 * and always the right one: a member on a phone and the same member on a laptop are one budget,
 * and two members behind one wifi are two.
 *
 * **Spent on what would have left the server, not on every request.** The budget is on messages
 * and URLs, and a body the service refuses produces neither — so a refused body costs nothing
 * here, and the validation that refuses it runs first. That is the opposite order from the
 * unauthenticated budgets, and the reason is what each protects: sign-in's budget guards the CPU a
 * probe spends, and a probe with a session is a member, who has better ways to waste our time.
 *
 * **Constants, not configuration.** How many bug reports a person sends in an hour, or how many
 * times they try to upload a picture, does not depend on where the product is deployed. The
 * numbers are here beside their reasons, and a deployment that needs different ones needs a
 * conversation, not an environment variable.
 *
 * **One counter per kind.** An admin uploading a Sunday's recording does not spend a budget shared
 * with their avatar, and cannot be locked out of one by the other.
 *
 * **This is one process's count.** See `rate-limit.ts`.
 */

export const ACTOR_BUDGET_KINDS = [
  'feedback',
  'avatar-grant',
  'recording-grant',
  'artwork-grant',
] as const;

export type ActorBudgetKind = (typeof ACTOR_BUDGET_KINDS)[number];

export interface ActorBudget {
  /** Requests one account may spend in the window. */
  readonly limit: number;
  readonly windowMs: number;
  /** The sentence before the wait, in the refusal a person reads. */
  readonly refusal: string;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The budgets, per hour.
 *
 * - **Feedback, ten.** A member who has just met a broken release and files half a dozen small
 *   reports in one sitting is a member worth having, and ten leaves them room. Ten messages an hour
 *   is also nothing like a flood to the inbox they land in.
 * - **Avatar grants, ten.** Ten attempts in an hour is a person fighting a file picker, not a
 *   workflow; the eleventh is a script.
 * - **Recording grants, thirty.** A backfill of a whole season in one sitting is the most an admin
 *   has ever needed, and the bulk path (prd 3.21.3) will get its own budget rather than borrow
 *   this one.
 * - **Artwork grants, thirty.** The same argument, for the same admin.
 */
export const ACTOR_BUDGETS: Readonly<Record<ActorBudgetKind, ActorBudget>> = {
  feedback: {
    limit: 10,
    windowMs: HOUR_MS,
    refusal: 'You have sent several reports in the last hour.',
  },
  'avatar-grant': {
    limit: 10,
    windowMs: HOUR_MS,
    refusal: 'Too many upload attempts.',
  },
  'recording-grant': {
    limit: 30,
    windowMs: HOUR_MS,
    refusal: 'Too many upload attempts.',
  },
  'artwork-grant': {
    limit: 30,
    windowMs: HOUR_MS,
    refusal: 'Too many upload attempts.',
  },
};

/**
 * How many accounts to remember per kind. A thousand is ten times the membership, and an account
 * that is being hammered stays at the fresh end of the map whatever else happens (`rate-limit.ts`),
 * so the cap can only ever evict accounts that are not spending.
 */
const MAX_TRACKED_ACCOUNTS = 1_000;

export interface ActorGuard {
  /** Spend one of `kind` for this account, or throw the refusal the caller is owed. */
  readonly spend: (kind: ActorBudgetKind, actor: { readonly id: string }, now?: number) => void;
}

/**
 * Build a guard over its own counters, one per kind.
 *
 * A factory rather than a module-level map so a test can hold one nothing else has spent from, and
 * so the budgets can be handed in — the shipped numbers are hours and tens, and a test that had to
 * make thirty-one requests to see one refusal would be proving the arithmetic the limiter's own
 * tests already prove.
 */
export function createActorGuard(
  budgets: Readonly<Record<ActorBudgetKind, ActorBudget>> = ACTOR_BUDGETS,
): ActorGuard {
  const limiters = new Map<ActorBudgetKind, RateLimiter>();
  for (const kind of ACTOR_BUDGET_KINDS) {
    const budget = budgets[kind];
    limiters.set(
      kind,
      createRateLimiter({
        limit: budget.limit,
        windowMs: budget.windowMs,
        maxKeys: MAX_TRACKED_ACCOUNTS,
      }),
    );
  }

  function spend(kind: ActorBudgetKind, actor: { readonly id: string }, now: number = Date.now()) {
    const limiter = limiters.get(kind);
    if (limiter === undefined) throw new Error(`no budget of kind "${kind}"`);

    const verdict = limiter.spend(actor.id, now);
    if (verdict.allowed) return;

    logger.warn('actor.rate-limited', {
      actorId: actor.id,
      action: kind,
      target: `account:${actor.id}`,
      reason: 'per-account-budget-spent',
      spent: verdict.spent,
    });
    const seconds = retryAfterSeconds(verdict.retryAfterMs);
    throw ApiError.rateLimited(
      seconds,
      `${budgets[kind].refusal} Try again in ${describeWait(seconds)}.`,
    );
  }

  return { spend };
}

/** The guard every service uses: one per process, built on first use. */
let shared: ActorGuard | undefined;

export function actorGuard(): ActorGuard {
  shared ??= createActorGuard();
  return shared;
}
