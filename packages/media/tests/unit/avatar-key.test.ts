import { describe, expect, it } from 'vitest';
import { mintArtworkKey, mintAvatarKey } from '@thp/media';

/**
 * **The avatar key minter** (docs/project/prd.md 3.1.12 — the pointer it names).
 *
 * `mintArtworkKey`'s rule, one prefix over, and the same two halves are asserted: an unguessable
 * server-generated name, and an extension that comes from the content type the grant will be
 * signed for rather than from a filename. What is new is the prefix — a person's picture and a
 * study's face live under different names, so an operator reading the bucket can tell them apart.
 */

/** `avatars/<uuid>.<ext>` — the uuid pinned as a literal shape, not read off the implementation. */
const KEY = /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/;

describe('the avatar key is minted, never derived', () => {
  it('names a WebP under the avatars prefix', () => {
    const key = mintAvatarKey('image/webp');
    expect(key).toMatch(KEY);
    expect(key.endsWith('.webp')).toBe(true);
    expect(key.startsWith('avatars/')).toBe(true);
  });

  it('names a JPEG and a PNG by the same table a cover uses', () => {
    expect(mintAvatarKey('image/jpeg').endsWith('.jpg')).toBe(true);
    expect(mintAvatarKey('image/png').endsWith('.png')).toBe(true);
  });

  it('is its own prefix, so a picture of a person is never filed as a cover', () => {
    expect(mintAvatarKey('image/webp').startsWith('artwork/')).toBe(false);
    expect(mintArtworkKey('image/webp').startsWith('avatars/')).toBe(false);
  });

  it('gives two grants two different names, so a key is never guessable from another', () => {
    expect(mintAvatarKey('image/webp')).not.toBe(mintAvatarKey('image/webp'));
  });

  it('throws for a content type outside the accepted image types rather than minting a key', () => {
    expect(() => mintAvatarKey('audio/mpeg')).toThrow();
    expect(() => mintAvatarKey('image/gif')).toThrow();
  });
});
