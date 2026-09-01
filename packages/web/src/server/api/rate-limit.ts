/**
 * A request budget, per key, over a sliding window.
 *
 * **In memory, in this process, and that is a complete answer here rather than a shortcut.**
 * `ecosystem.config.cjs` runs the web app as `exec_mode: 'fork'` with `instances: 1`, so there is
 * exactly one process holding this map and the count it holds is the count. The day that line
 * becomes cluster mode with N instances, every limit below silently becomes N times looser — which
 * is why {@link createRateLimiter} is a factory over an injectable store rather than a module-level
 * global, and why the pairing is said out loud in both files. A limiter whose correctness depends
 * on a process-manager setting should name the setting.
 *
 * **Sliding window over a log of timestamps**, not a fixed window. A fixed window is one line
 * shorter and lets a caller spend the whole budget in the last second of one window and the whole
 * budget again in the first second of the next — twice the limit, delivered as a burst, which is
 * exactly the shape of the abuse a limiter is for. The log is exact, and at this scale it is also
 * cheap: the budget bounds the array length, so a key holds at most `limit` numbers.
 *
 * **It refuses; it never waits.** A limiter that sleeps holds a connection open, which turns a
 * request flood into a resource exhaustion it was supposed to prevent.
 */

export interface RateLimitPolicy {
  /** How many requests one key may spend in the window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * How many distinct keys to track before evicting.
   *
   * There has to be a cap: the keys are attacker-supplied addresses, and a map that grows one entry
   * per address is a memory leak with a remote trigger. When the cap is reached the
   * **least-recently-seen** key is dropped, which is the right one to lose — an entry nobody has
   * touched in a while is an entry whose window is nearest to expiring anyway.
   *
   * This is a genuine trade rather than a solved problem: an attacker with many addresses can churn
   * keys fast enough to evict a key that is over its budget, and get it a fresh one. That costs
   * them a distinct address per evicted entry, and the whole-route ceiling (which shares no key
   * with anybody) is what still holds when it happens.
   */
  readonly maxKeys: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** How long until the oldest spent request falls out of the window. `0` when allowed. */
  readonly retryAfterMs: number;
  /** Requests spent in the window, this one included when it was allowed. */
  readonly spent: number;
}

export interface RateLimiter {
  /**
   * Spend one request against `key`.
   *
   * **Spending is the check** — there is no separate "record it afterwards" step, because a limiter
   * with two calls is a limiter somebody will one day only make the first of. A refused request
   * spends nothing, so being over budget does not extend the block by hammering it.
   */
  readonly spend: (key: string, now?: number) => RateLimitVerdict;
  /** How many keys are currently tracked. For tests and for a diagnostic, never for a decision. */
  readonly size: () => number;
}

export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
  const { limit, windowMs, maxKeys } = policy;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`A rate limit must be a positive whole number of requests, not ${limit}.`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`A rate limit window must be a positive number of ms, not ${windowMs}.`);
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error(`A rate limiter must track at least one key, not ${maxKeys}.`);
  }

  /**
   * Insertion-ordered by the language, which is what makes eviction free: re-inserting a key on
   * every touch moves it to the end, so the first entry `keys()` yields is the least recently seen.
   */
  const hits = new Map<string, number[]>();

  function spend(key: string, now: number = Date.now()): RateLimitVerdict {
    // Strictly older than the window is out. A request made at `t` is gone at `t + windowMs`,
    // which is exactly when `retryAfterMs` promised the budget back — `>=` here would hold it one
    // millisecond longer than the number the caller was handed, and send them back to a refusal.
    const cutoff = now - windowMs;
    const previous = hits.get(key);
    // Kept rather than filtered in place: the array is at most `limit` long, and a fresh array
    // means a caller holding the old one cannot see it change underneath them.
    const live = previous === undefined ? [] : previous.filter((at) => at > cutoff);

    if (live.length >= limit) {
      // Re-inserted even on a refusal, so a key that is being hammered stays at the fresh end of
      // the map and cannot be evicted into a fresh budget by its own traffic.
      touch(key, live);
      const oldest = live[0] ?? now;
      return { allowed: false, retryAfterMs: Math.max(0, oldest + windowMs - now), spent: live.length };
    }

    live.push(now);
    touch(key, live);
    return { allowed: true, retryAfterMs: 0, spent: live.length };
  }

  function touch(key: string, live: number[]): void {
    hits.delete(key);
    hits.set(key, live);
    if (hits.size <= maxKeys) return;

    // Over the cap. Drop from the stale end until it fits — a loop rather than a single delete,
    // because the cap can be crossed by more than one if a policy is ever built with a smaller cap
    // than the map already holds.
    for (const stale of hits.keys()) {
      if (hits.size <= maxKeys) break;
      if (stale !== key) hits.delete(stale);
    }
  }

  return { spend, size: () => hits.size };
}
