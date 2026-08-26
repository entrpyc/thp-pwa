import { randomUUID } from 'node:crypto';
import { extensionForArtworkType, extensionForContentType } from '@thp/shared';
import { buildMediaStore } from './s3-store';

/**
 * **The media store, as the application is allowed to see it.**
 *
 * One port, one adapter behind it, and the vendor named in configuration rather than in code — the
 * same shape as the mail boundary, and enforced the same way: tools/media-boundary.ts fails the
 * build if anything outside `s3-store.ts` imports the S3 SDK. A second import would be a second
 * door to the bucket, one that does not go through the key minting below and does not have to obey
 * the interface's most important property.
 *
 * **That property is what is missing. There is no delete.** "The original is never overwritten or
 * deleted" (docs/project/prd.md, 3.4.9;
 * core-listening scope tdd § Media store calls it the one non-negotiable) is
 * a fact about this type rather than about anybody's discipline: there is nothing to call. An
 * upload that is refused at finalisation leaves its object where it is, and that orphan is the
 * price — it is invisible, the list reads `recording` rows, and it is cheaper than any mechanism
 * capable of removing the input Story 3 and every re-transcription afterwards depend on.
 *
 * **This is a package beside `@thp/db` and `@thp/shared`, not a folder in the web app.** It lived
 * under `packages/web/src/server/media/` while the API was the only thing that read the store;
 * Story 2 Ticket 03's worker has to read the original in order to transcribe it, and the
 * import-boundary guard refuses a worker that reaches into `packages/web`. So the port moved to
 * where both processes can name it, and it is server-only by the same rule `@thp/db` is. Nothing
 * else about it changed — the guard, the missing delete and the call sites all survived the move.
 *
 * Three operations, because three is what the application does:
 *
 * 1. **Mint a presigned `PUT`**, so the browser sends the bytes and they never pass through us.
 * 2. **Ask what actually landed**, so finalisation re-checks size and content type against the
 *    store's own metadata rather than against anything the client says. That is the only thing
 *    "re-checked server-side" can mean when the API never sees the file.
 * 3. **Mint a presigned `GET`**, so a reader we have authorised gets a short-lived grant to the
 *    object rather than the bytes travelling through us. The transcription handler hands one to the
 *    ASR provider; Story 4's playback hands one to the browser.
 */

/** What the store reports about an object that exists. */
export interface StoredObject {
  readonly size: number;
  /** What the object was stored as — the type the grant was signed for. */
  readonly contentType: string;
}

export interface PresignedPut {
  readonly url: string;
  readonly key: string;
  readonly contentType: string;
  readonly expiresAt: Date;
}

export interface MediaStore {
  /** Which adapter is in use, for the log line. Never a vendor decision made in code. */
  readonly name: string;

  /**
   * A `PUT` bound to this key **and this content type**, expiring after `expiresInSeconds`.
   *
   * The content type is a signed header, not a hint: a `PUT` presenting a different one fails the
   * signature at the store. Presigning cannot make a URL single-use — there is no such thing — so
   * what stops a grant being reused is that the key is minted per request and is not guessable.
   */
  presignPut(input: {
    readonly key: string;
    readonly contentType: string;
    readonly expiresInSeconds: number;
  }): Promise<string>;

  /** The object's size and content type, or `null` when nothing is behind the key. */
  head(key: string): Promise<StoredObject | null>;

  /**
   * A `GET` for this key, expiring after `expiresInSeconds`.
   *
   * **The presigned `PUT`'s counterpart, and the same boundary in the other direction.** The bucket
   * is never publicly readable, so a signature is the only way anything reads an object — and what
   * is handed out is a grant with an expiry on it rather than the bytes, so neither process ever
   * carries the audio.
   *
   * The expiry is the caller's, not the port's: what a browser needs for one sitting and what a
   * transcription provider needs to fetch a 200 MB file are different numbers, and each belongs
   * beside the reason for it.
   */
  presignGet(input: { readonly key: string; readonly expiresInSeconds: number }): Promise<string>;
}

/**
 * One hour. Long enough for a 200 MB upload on a domestic connection, short enough that a grant
 * copied out of a browser's network tab is not a standing invitation to write to the bucket.
 */
export const UPLOAD_GRANT_SECONDS = 60 * 60;

/**
 * `originals/<uuid>.<ext>` — **minted here, never derived from what the client sent.**
 *
 * The filename a person chose is theirs and arbitrary: it can collide, it can carry a path, it can
 * carry anything at all. A server-minted uuid makes the key unguessable, which is what a presigned
 * URL's reusability costs us; and the extension comes from the content type the grant is signed
 * for rather than from the name, so the two can never disagree.
 *
 * `originals/` is a prefix rather than a bucket, because
 * core-listening scope tdd § Extension points has processed renditions
 * arriving beside it later.
 */
export function mintOriginalKey(contentType: string): string {
  const extension = extensionForContentType(contentType);
  if (extension === null) {
    // Unreachable from the routes — the content type is checked before a key is asked for. Stated
    // rather than assumed, so a future caller that skips the check fails here instead of writing an
    // object nobody can name the format of.
    throw new Error(`no accepted audio extension for content type "${contentType}"`);
  }
  return `originals/${randomUUID()}.${extension}`;
}

let store: MediaStore | undefined;

/**
 * The store, built once and cached. Building it per request would build an S3 client per request,
 * which is the same reason the mailer caches its transport.
 */
export function mediaStore(): MediaStore {
  store ??= buildMediaStore();
  return store;
}

/**
 * `artwork/<uuid>.<ext>` — **`mintOriginalKey`'s rule, one prefix over** (scope tdd 1.1).
 *
 * A series cover is a second use of this one port rather than a second boundary, so the key it is
 * stored under is minted the same way and for the same two reasons: the name a person's file
 * carried is arbitrary and can collide, and a server-minted uuid is what a presigned URL's
 * reusability costs us. The extension comes from the content type the grant will be signed for, so
 * the object's name and its format cannot disagree.
 *
 * **It brings no delete with it.** Replacing a cover writes a new key and repoints the series
 * (scope prd 3.1.5); the superseded object stays where it is, unreferenced and invisible, which is
 * the same accepted price the refused-audio-upload case already pays.
 */
export function mintArtworkKey(contentType: string): string {
  const extension = extensionForArtworkType(contentType);
  if (extension === null) {
    // Unreachable from the routes — the content type is checked before a key is asked for. Stated
    // rather than assumed, so a future caller that skips the check fails here instead of writing an
    // object nobody can name the format of.
    throw new Error(`no accepted artwork extension for content type "${contentType}"`);
  }
  return `artwork/${randomUUID()}.${extension}`;
}
