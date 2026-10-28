import type { SearchHitRow } from '@thp/db';

/**
 * **The search cache** — one answered search, kept until the end of the week.
 *
 * The operator asked for search results to be cached and for the cache to empty **every Sunday at
 * 23:59**: the library changes on the week's rhythm — a Sunday's teaching is recorded, processed
 * and published — and a member asking the same question twice in a week deserves the same answer
 * at once rather than another provider call and another fused query. So an entry is not kept for a
 * duration; it is kept until the week ends. {@link searchCacheExpiresAt} is that one rule, and it
 * is the only clock here. The week ends in **UTC**, which is the zone everything else on the server
 * is dated in (the mail, the public documents); a Sunday 23:59 local would need a zone the product
 * does not yet name.
 *
 * **Keyed by account and by the whole request.** What a search answers depends on who asked —
 * the visibility rule admits a member's own notes and nobody else's — so two members asking the
 * same words are two entries. The request is keyed by its canonical address (`searchPath`), so
 * two spellings of one search are one entry and the offset of a "Show more" page is its own.
 *
 * **What is kept is the database's rows, not the payload.** A hit's series cover is a signed URL
 * that lasts a couple of hours, and a payload kept for a week would hand out dead links by
 * Tuesday; the rows carry the artwork *key*, and the service signs it again on every read. A
 * degraded search — the provider failed and the rows are words-only — is **never written**: the
 * next ask should try the provider again, not repeat the failure for a week.
 *
 * **In memory, in this process**, for the reason `rate-limit.ts` gives: `ecosystem.config.cjs`
 * runs one web process, and a restart emptying the cache costs nothing but a provider call per
 * search. Bounded, like the limiter's map, by evicting the least recently read entry; the cap is
 * generous because an entry is eleven rows of text and a week of a small congregation's searches
 * is a few thousand of them.
 */

export interface SearchCacheEntry {
  readonly rows: readonly SearchHitRow[];
}

export interface SearchCache {
  /** The rows kept for `key`, or `null` when there are none or they have expired. */
  readonly get: (key: string, now?: number) => SearchCacheEntry | null;
  /** Keep `entry` under `key` until the week ends. */
  readonly set: (key: string, entry: SearchCacheEntry, now?: number) => void;
  /** How many entries are held, expired ones included until they are read. For tests. */
  readonly size: () => number;
  /** Drop everything. For tests, and for an operator's reset. */
  readonly clear: () => void;
}

export interface SearchCachePolicy {
  /** How many entries to hold before the least recently read one is dropped. */
  readonly maxEntries: number;
}

export const DEFAULT_SEARCH_CACHE_POLICY: SearchCachePolicy = { maxEntries: 5000 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an entry written at `now` expires: **the end of that Sunday, 23:59:59.999 UTC** — which is
 * the instant before the next Monday begins. An entry written on a Sunday evening lives until
 * midnight that same night; one written on a Monday morning lives all week.
 */
export function searchCacheExpiresAt(now: number): number {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  // Sunday is `0`; the days left until the next Monday's midnight, counting today as a whole day.
  const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
  return dayStart + daysUntilMonday * DAY_MS - 1;
}

/** The key one account's search is kept under: who asked, and the canonical address of what. */
export function searchCacheKey(actorId: string, requestPath: string): string {
  return `${actorId}\u0000${requestPath}`;
}

export function createSearchCache(
  policy: SearchCachePolicy = DEFAULT_SEARCH_CACHE_POLICY,
): SearchCache {
  const { maxEntries } = policy;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`A search cache must hold at least one entry, not ${maxEntries}.`);
  }

  interface Kept {
    readonly entry: SearchCacheEntry;
    readonly expiresAt: number;
  }

  // Insertion-ordered, and re-inserted on every read, so the first key is the least recently read.
  const kept = new Map<string, Kept>();

  return {
    get(key, now = Date.now()) {
      const found = kept.get(key);
      if (found === undefined) return null;
      if (now > found.expiresAt) {
        kept.delete(key);
        return null;
      }
      kept.delete(key);
      kept.set(key, found);
      return found.entry;
    },
    set(key, entry, now = Date.now()) {
      kept.delete(key);
      kept.set(key, { entry, expiresAt: searchCacheExpiresAt(now) });
      while (kept.size > maxEntries) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
    },
    size: () => kept.size,
    clear: () => kept.clear(),
  };
}

let shared: SearchCache | null = null;

/** The process's one cache, built on first use. */
export function searchCache(): SearchCache {
  shared ??= createSearchCache();
  return shared;
}
