import { beforeAll, describe, expect, it, inject } from 'vitest';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintOriginalKey, type MediaStore } from '@thp/media';

/**
 * The media store, driven against the **real** MinIO container rather than a stub.
 *
 * Everything asserted here is a property of a store and of nothing else: what a presigned URL
 * actually authorises, what it stops authorising when the content type changes, what happens after
 * it expires, and — the one that matters most — that an object in this bucket is **not readable
 * without a signature** (docs/project/prd.md §6 Security). A fake would answer all four however we
 * wrote it, which is exactly why there isn't one.
 *
 * Production is Cloudflare R2 and this is MinIO. They are not the same product, and the properties
 * above are the S3 protocol rather than either vendor — which is the whole reason the adapter
 * speaks plain S3. The one thing the suite therefore cannot prove about the *deployment's* bucket
 * is that its access posture and CORS rule were actually applied, and that is a manual check in the
 * ticket's user steps.
 */

const settings = inject('mediaSettings');

/** The plain, unsigned URL of an object. Path style, because that is how the client is built. */
function unsignedUrl(key: string): string {
  return `${settings.MEDIA_ENDPOINT.replace(/\/+$/, '')}/${settings.MEDIA_BUCKET}/${key}`;
}

const AUDIO = 'audio/mpeg';

/** Small, and not empty — an object of zero bytes is a different case from one that arrived. */
function bytes(size = 32): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(size)).fill(7);
}

let store: MediaStore;

beforeAll(() => {
  // The store reads its five values from the environment with no defaults, and the suite's bucket
  // is not the one `.env` names — so the worker is given the same configuration the servers got.
  Object.assign(process.env, settings);
  store = mediaStore();
});

describe('a presigned PUT', () => {
  it('is bound to the key and the content type, and lands the object', async () => {
    const key = mintOriginalKey(AUDIO);
    const url = await store.presignPut({
      key,
      contentType: AUDIO,
      expiresInSeconds: UPLOAD_GRANT_SECONDS,
    });

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': AUDIO },
      body: bytes(64),
    });
    expect(response.status).toBe(200);

    const stored = await store.head(key);
    expect(stored).toEqual({ size: 64, contentType: AUDIO });
  });

  it('expires one hour after issue', async () => {
    const url = await store.presignPut({
      key: mintOriginalKey(AUDIO),
      contentType: AUDIO,
      expiresInSeconds: UPLOAD_GRANT_SECONDS,
    });
    // The expiry is on the wire, not in a comment: the store enforces this number, not us.
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(UPLOAD_GRANT_SECONDS).toBe(60 * 60);
  });

  it('is refused when the PUT presents a different content type', async () => {
    const key = mintOriginalKey(AUDIO);
    const url = await store.presignPut({ key, contentType: AUDIO, expiresInSeconds: 3600 });

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'audio/flac' },
      body: bytes(),
    });

    // The content type is a *signed* header, so this fails the signature rather than a policy — the
    // store never reads the body at all.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    expect(await store.head(key)).toBeNull();
  });

  it('is refused once it has expired', async () => {
    const key = mintOriginalKey(AUDIO);
    const url = await store.presignPut({ key, contentType: AUDIO, expiresInSeconds: 1 });
    await new Promise((done) => setTimeout(done, 2_500));

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': AUDIO },
      body: bytes(),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
    expect(await store.head(key)).toBeNull();
  }, 30_000);

  it('mints a different key every time, whatever the file was called', () => {
    const keys = new Set(Array.from({ length: 20 }, () => mintOriginalKey(AUDIO)));
    expect(keys.size).toBe(20);
    for (const key of keys) expect(key).toMatch(/^originals\/[0-9a-f-]{36}\.mp3$/);
  });
});

describe('the bucket is never publicly readable', () => {
  it('refuses a GET of an object that exists, with no signature', async () => {
    const key = mintOriginalKey(AUDIO);
    const url = await store.presignPut({ key, contentType: AUDIO, expiresInSeconds: 3600 });
    const put = await fetch(url, { method: 'PUT', headers: { 'content-type': AUDIO }, body: bytes() });
    expect(put.status).toBe(200);
    // The object is genuinely there — otherwise the refusal below would be a 404 wearing a costume.
    expect(await store.head(key)).not.toBeNull();

    const unsigned = await fetch(unsignedUrl(key));
    expect(unsigned.ok).toBe(false);
    expect(unsigned.status).toBe(403);
  });

  it('refuses a listing of the bucket to an unsigned caller', async () => {
    const listing = await fetch(`${settings.MEDIA_ENDPOINT}/${settings.MEDIA_BUCKET}`);
    expect(listing.ok).toBe(false);
  });
});

/**
 * The presigned `GET` (Story 2 Ticket 03).
 *
 * The `PUT`'s counterpart, and the only way anything reads an object out of a bucket that is never
 * publicly readable. The transcription handler hands one to the ASR provider; Story 4's playback
 * hands one to the browser. Both properties that matter are properties of the store — that the URL
 * genuinely fetches the bytes, and that it genuinely stops doing so — so both are driven against
 * MinIO rather than asserted about a query string.
 */
describe('a presigned GET', () => {
  /** Put an object there and hand back its key, so a read has something to read. */
  async function stored(size = 48): Promise<{ key: string; body: Uint8Array }> {
    const key = mintOriginalKey(AUDIO);
    const body = bytes(size);
    const url = await store.presignPut({ key, contentType: AUDIO, expiresInSeconds: 3600 });
    const put = await fetch(url, { method: 'PUT', headers: { 'content-type': AUDIO }, body });
    expect(put.status).toBe(200);
    return { key, body };
  }

  it('fetches the object it was minted for, byte for byte', async () => {
    const { key, body } = await stored(96);

    const url = await store.presignGet({ key, expiresInSeconds: 3600 });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it('is refused once it has expired', async () => {
    const { key } = await stored();
    const url = await store.presignGet({ key, expiresInSeconds: 1 });
    // It works while it is alive — otherwise the refusal below would prove nothing about expiry.
    expect((await fetch(url)).status).toBe(200);

    await new Promise((done) => setTimeout(done, 2_500));

    const response = await fetch(url);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  }, 30_000);

  it('carries the expiry it was asked for, on the wire', async () => {
    const { key } = await stored();
    const url = await store.presignGet({ key, expiresInSeconds: 7_200 });
    // The store enforces this number, not us.
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('7200');
  });

  it('is a different URL each time it is minted, so a browser cannot cache it', async () => {
    // The property the cacheable grant below is the exception to, pinned here so that it stays an
    // exception: an audio grant re-minted per sitting is a fresh URL per sitting.
    const { key } = await stored();
    const first = await store.presignGet({ key, expiresInSeconds: 3600 });
    await new Promise((done) => setTimeout(done, 1_100));
    const second = await store.presignGet({ key, expiresInSeconds: 3600 });
    expect(second).not.toBe(first);
  });

  it('authorises that key and no other', async () => {
    const first = await stored();
    const second = await stored();

    const url = await store.presignGet({ key: first.key, expiresInSeconds: 3600 });
    const swapped = url.replace(first.key.split('/')[1] ?? '', second.key.split('/')[1] ?? '');

    // The key is part of what was signed, so pointing a grant at a neighbour fails the signature
    // rather than handing over the neighbour.
    expect(swapped).not.toBe(url);
    const response = await fetch(swapped);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(403);
  });

  describe('a cacheable presigned GET', () => {
    it('is the same URL every time it is minted within the window', async () => {
      // What a browser cache needs and what an ordinary grant cannot give it: the same key signed
      // twice, a second apart, is the same string — because both are signed as of the window's
      // start rather than as of now.
      const { key } = await stored();
      // A day-long window so that the two mints cannot straddle a window boundary in practice.
      const cache = { windowSeconds: 86_400 };
      const first = await store.presignGet({ key, expiresInSeconds: 172_800, cache });
      await new Promise((done) => setTimeout(done, 1_100));
      const second = await store.presignGet({ key, expiresInSeconds: 172_800, cache });
      expect(second).toBe(first);
    });

    it('fetches the object and tells the browser to keep it for the window', async () => {
      const { key, body } = await stored(48);
      const url = await store.presignGet({
        key,
        expiresInSeconds: 7200,
        cache: { windowSeconds: 3600 },
      });

      const response = await fetch(url);
      expect(response.status).toBe(200);
      // The store enforces the header, not us: it is a signed response parameter, so the bucket
      // answers it on this URL and on no other.
      expect(response.headers.get('cache-control')).toBe('private, max-age=3600, immutable');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    });

    it('refuses an expiry shorter than twice the window', async () => {
      // A URL minted at the end of a window would otherwise stop working partway through the next
      // one — and from the screen that is a cover that went missing for no reason.
      const { key } = await stored();
      await expect(
        store.presignGet({ key, expiresInSeconds: 3600, cache: { windowSeconds: 3600 } }),
      ).rejects.toThrow(/twice its window/);
    });
  });
});

describe('the bucket answers a CORS preflight for the browser PUT', () => {
  it('permits PUT and the content-type header from the application origin', async () => {
    // Without this rule the browser cannot make the upload **at all** — the preflight fails and the
    // PUT is never sent, which looks from the screen like the store being down.
    const origin = inject('apiBaseUrl');
    const response = await fetch(unsignedUrl(mintOriginalKey(AUDIO)), {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBeLessThan(300);
    const allowedOrigin = response.headers.get('access-control-allow-origin');
    expect(allowedOrigin === '*' || allowedOrigin === origin).toBe(true);
    expect(response.headers.get('access-control-allow-methods') ?? '').toContain('PUT');
    expect((response.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'content-type',
    );
  });
});

describe('asking what is behind a key', () => {
  it('answers null for a key nothing was ever put at', async () => {
    // "Nothing is there" is an answer rather than a failure — finalisation refuses on it by name.
    expect(await store.head(mintOriginalKey(AUDIO))).toBeNull();
  });
});
