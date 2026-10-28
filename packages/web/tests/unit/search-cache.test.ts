import { describe, expect, it } from 'vitest';
import type { SearchHitRow } from '@thp/db';
import { createSearchCache, searchCacheExpiresAt, searchCacheKey } from '@/server/search/cache';

/**
 * The search cache: the week rule, the eviction, and the key — driven with an injected clock.
 *
 * The integration suite (`search.test.ts`) proves the cache sits where it should in the service:
 * a search asked twice spends one budget. This file is the arithmetic of *until when* an answer is
 * kept.
 */

function utc(iso: string): number {
  return new Date(iso).getTime();
}

const row = { embeddingId: 'e1' } as unknown as SearchHitRow;
const entry = { rows: [row] };

describe('when an entry expires (every Sunday 23:59, UTC)', () => {
  it('an entry written on a Monday lives until the end of that Sunday', () => {
    // 2026-10-26 is a Monday.
    expect(searchCacheExpiresAt(utc('2026-10-26T09:15:00.000Z'))).toBe(utc('2026-11-01T23:59:59.999Z'));
  });

  it('an entry written on a Sunday evening lives until midnight that night', () => {
    expect(searchCacheExpiresAt(utc('2026-11-01T22:30:00.000Z'))).toBe(utc('2026-11-01T23:59:59.999Z'));
  });

  it('an entry written in the last millisecond of a Sunday expires at once; one written a millisecond later lives a week', () => {
    expect(searchCacheExpiresAt(utc('2026-11-01T23:59:59.999Z'))).toBe(utc('2026-11-01T23:59:59.999Z'));
    expect(searchCacheExpiresAt(utc('2026-11-02T00:00:00.000Z'))).toBe(utc('2026-11-08T23:59:59.999Z'));
  });

  it('is read back until the week ends and not after', () => {
    const cache = createSearchCache({ maxEntries: 10 });
    const written = utc('2026-10-28T12:00:00.000Z');
    cache.set('k', entry, written);
    expect(cache.get('k', utc('2026-11-01T23:59:59.999Z'))).toEqual(entry);
    expect(cache.get('k', utc('2026-11-02T00:00:00.000Z'))).toBeNull();
    // Reading an expired entry drops it.
    expect(cache.size()).toBe(0);
  });
});

describe('what the cache holds', () => {
  it('drops the least recently read entry past the cap', () => {
    const cache = createSearchCache({ maxEntries: 2 });
    const now = utc('2026-10-28T12:00:00.000Z');
    cache.set('a', entry, now);
    cache.set('b', entry, now);
    // `a` is read, so `b` is the stale one when `c` arrives.
    expect(cache.get('a', now)).not.toBeNull();
    cache.set('c', entry, now);
    expect(cache.size()).toBe(2);
    expect(cache.get('b', now)).toBeNull();
    expect(cache.get('a', now)).not.toBeNull();
    expect(cache.get('c', now)).not.toBeNull();
  });

  it('a write replaces what was under the key', () => {
    const cache = createSearchCache({ maxEntries: 2 });
    const now = utc('2026-10-28T12:00:00.000Z');
    cache.set('a', entry, now);
    cache.set('a', { rows: [] }, now);
    expect(cache.get('a', now)).toEqual({ rows: [] });
    expect(cache.size()).toBe(1);
  });

  it('refuses a cap that holds nothing', () => {
    expect(() => createSearchCache({ maxEntries: 0 })).toThrow();
  });
});

describe('the key', () => {
  it('is per account and per address', () => {
    expect(searchCacheKey('alice', '/search?q=grace')).not.toBe(searchCacheKey('bob', '/search?q=grace'));
    expect(searchCacheKey('alice', '/search?q=grace')).not.toBe(searchCacheKey('alice', '/search?q=grace&offset=10'));
    expect(searchCacheKey('alice', '/search?q=grace')).toBe(searchCacheKey('alice', '/search?q=grace'));
  });
});
