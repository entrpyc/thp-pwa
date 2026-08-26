import { describe, expect, it } from 'vitest';
import { mintArtworkKey } from '@thp/media';

/**
 * **The artwork key minter** (scope prd 3.1.7 — the pointer it names; scope tdd 1.1).
 *
 * The same rule `mintOriginalKey` holds, one prefix over: the key is minted here and never derived
 * from what the client sent. What is asserted is the two halves of that — an unguessable
 * server-generated name, and an extension that comes from the content type the grant will be
 * signed for rather than from a filename.
 */

/** `artwork/<uuid>.<ext>` — the uuid pinned as a literal shape, not read off the implementation. */
const KEY = /^artwork\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/;

describe('the artwork key is minted, never derived', () => {
  it('names a WebP under the artwork prefix', () => {
    const key = mintArtworkKey('image/webp');
    expect(key).toMatch(KEY);
    expect(key.endsWith('.webp')).toBe(true);
    expect(key.startsWith('artwork/')).toBe(true);
  });

  it('names a JPEG and a PNG by the same table', () => {
    expect(mintArtworkKey('image/jpeg').endsWith('.jpg')).toBe(true);
    expect(mintArtworkKey('image/png').endsWith('.png')).toBe(true);
  });

  it('gives two grants two different names, so a key is never guessable from another', () => {
    expect(mintArtworkKey('image/webp')).not.toBe(mintArtworkKey('image/webp'));
  });

  it('throws for a content type outside the accepted image types rather than minting a key', () => {
    // Unreachable from the routes — the type is checked before a key is asked for. Stated rather
    // than assumed, so a future caller that skips the check fails here instead of writing an object
    // nobody can name the format of. Audio is the case worth pinning: the two minters share a
    // store and must not share a table.
    expect(() => mintArtworkKey('audio/mpeg')).toThrow();
    expect(() => mintArtworkKey('image/gif')).toThrow();
  });
});
