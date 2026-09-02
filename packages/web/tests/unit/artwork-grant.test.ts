import { describe, expect, it } from 'vitest';
import type { MediaStore, StoredObject } from '@thp/media';
import {
  ARTWORK_CACHE_WINDOW_SECONDS,
  ARTWORK_GRANT_SECONDS,
  mintArtworkGrant,
} from '@/server/series/artwork-grant';

/**
 * **What a cover's signed URL is signed for** (scope plan 1.3.6; scope tdd 1.4).
 *
 * Asserted against a recording store rather than a clock: the expiry is an argument the port is
 * handed, so the rule can be read off the call instead of waited for. The store the real minter
 * uses is the same port, so what is proved here is the number the API asks for — and the store's
 * own enforcement of it is `media/tests/integration/store.test.ts`'s.
 */

interface Asked {
  readonly key: string;
  readonly expiresInSeconds: number;
  readonly cache: { readonly windowSeconds: number } | undefined;
}

function recordingStore(): { store: MediaStore; asked: Asked[] } {
  const asked: Asked[] = [];
  const store: MediaStore = {
    name: 'recording',
    presignPut: async () => 'unused',
    head: async (): Promise<StoredObject | null> => null,
    presignGet: async (input) => {
      asked.push({ key: input.key, expiresInSeconds: input.expiresInSeconds, cache: input.cache });
      return `https://store.test/${input.key}?X-Amz-Expires=${input.expiresInSeconds}`;
    },
  };
  return { store, asked };
}

describe('a cover is handed out as a grant a browser may keep for the day', () => {
  it('signs for two days, cacheable in windows of one', async () => {
    // The literals, not the module's own constants read back at themselves — an assertion that
    // took its expectation from the code would agree with whatever the code held, including a
    // wrong value. Two days for one because the store refuses anything less: a URL minted at the
    // end of one window has to be honoured for the whole of the next.
    expect(ARTWORK_CACHE_WINDOW_SECONDS).toBe(86_400);
    expect(ARTWORK_GRANT_SECONDS).toBe(172_800);

    const { store, asked } = recordingStore();
    await mintArtworkGrant('artwork/abc.webp', store);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.expiresInSeconds).toBe(172_800);
    expect(asked[0]?.cache).toEqual({ windowSeconds: 86_400 });
    expect(asked[0]?.key).toBe('artwork/abc.webp');
  });

  it('answers null for a series with no cover, without asking the store for anything', async () => {
    // scope prd 3.1.7 at the one place the URL is minted: no cover is not an error and not an
    // empty string, and it costs no signature.
    const { store, asked } = recordingStore();

    expect(await mintArtworkGrant(null, store)).toBeNull();
    expect(asked).toHaveLength(0);
  });

  it('answers a URL that carries the signature, never the bare key', async () => {
    const { store } = recordingStore();
    const url = await mintArtworkGrant('artwork/abc.webp', store);

    expect(url).toContain('X-Amz-Expires=172800');
    expect(url).not.toBe('artwork/abc.webp');
  });
});
