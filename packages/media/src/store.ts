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
 * **That property is what is missing. There is no general delete.** "The original is never
 * overwritten or deleted" (docs/project/prd.md, 3.4.9;
 * core-listening scope tdd § Media store calls it the one non-negotiable) is
 * a fact about this type rather than about anybody's discipline: there is nothing to call. An
 * upload that is refused at finalisation leaves its object where it is, and that orphan is the
 * price — it is invisible, the list reads `recording` rows, and it is cheaper than any mechanism
 * capable of removing the input Story 3 and every re-transcription afterwards depend on.
 *
 * The one exception is `deleteAvatar`, which account deletion needs and which reaches the
 * `avatars/` prefix and nothing else — see the member, and the guard that pins it to that name.
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
   *
   * **`cache` makes the grant one a browser can keep.** A fresh signature is a fresh URL, and a
   * browser caches by URL — so a picture signed anew on every page is fetched anew on every page,
   * and repaints from nothing each time. With `cache` set, the same key answers the *same* URL
   * for `windowSeconds` at a stretch and the response carries a `Cache-Control` telling the
   * browser to hold it for that long; the second page that shows the picture paints it from disk.
   * The caller's `expiresInSeconds` has to be at least twice the window, so a URL minted at the
   * very end of one window is still honoured for the whole of the next. Audio never sets it: a
   * playback grant is one sitting's, and its expiry is the property playback is built on.
   */
  presignGet(input: {
    readonly key: string;
    readonly expiresInSeconds: number;
    readonly cache?: { readonly windowSeconds: number };
  }): Promise<string>;

  /**
   * **The one delete on this port, and it reaches one prefix.**
   *
   * Account deletion ([3.1.8](docs/project/prd.md); packages/db/src/README.md) has to be able to
   * take a person's picture out of the store, and "the key is dropped and the object stays" is
   * not deletion in the sense Apple 5.1.1(v) and Google Play mean it. So the no-delete property
   * narrows rather than breaks: the original audio, the renditions, the previews and the covers
   * are still unreachable by anything on this type, and tools/media-boundary.ts still fails the
   * build on any *other* member whose name says it removes something.
   *
   * The adapter refuses — throws, before any request is made — a key that does not begin with
   * `avatars/`. That check is in the adapter and not only here in prose, so a caller that got
   * hold of an original's key could not widen this into the delete the product does not have.
   * Deleting a key nothing is behind is a success: the state asked for is the state there is.
   */
  deleteAvatar(key: string): Promise<void>;

  /**
   * The second permitted delete, confined to `note-images/` the way `deleteAvatar` is to
   * `avatars/` ([3.12.24](docs/project/prd.md); packages/db/src/README.md): a picture taken off a
   * note, a note removed with its pictures, and a leaving member's private notes each have an
   * object nothing will ever mint a URL for again. The original audio stays unreachable.
   */
  deleteNoteImage(key: string): Promise<void>;
}

/** The prefix {@link MediaStore.deleteAvatar} is confined to. The adapter checks against this. */
export const AVATAR_KEY_PREFIX = 'avatars/';

/** Where a note's pictures live — the one other prefix the store may delete under. */
export const NOTE_IMAGE_KEY_PREFIX = 'note-images/';

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

/**
 * `playback/<uuid>.<ext>` — **`mintOriginalKey`'s rule, one prefix over**, for the processed
 * rendition [§3.4](docs/project/prd.md)'s `process_audio` step writes.
 *
 * The extension is the caller's because the step knows what it produced — `m4a` from the real
 * transcoder, the original's own extension from the fake that copies instead of transcoding — and
 * a mint that guessed would name a format the object is not.
 *
 * **It brings no delete with it.** A re-run writes a new key and repoints the recording; the
 * superseded object stays where it is, unreferenced and invisible — the same accepted price
 * replaced artwork pays.
 */
export function mintPlaybackKey(extension: string): string {
  return `playback/${randomUUID()}.${extension}`;
}

/** Which of a preview's two excerpts an object is: the original plain, or under the profile. */
export type PreviewSide = 'before' | 'after';

/**
 * `preview/<uuid>-before.<ext>` and `preview/<uuid>-after.<ext>` — **`mintPlaybackKey`'s rule,
 * one prefix over**, for the two excerpts a sound-profile preview leaves
 * ([3.4.6](docs/project/prd.md)).
 *
 * A prefix of its own so a reader of the bucket can tell thirty seconds nobody will play twice
 * from the rendition members hear, and so that the day a lifecycle rule expires previews it has
 * one prefix to name. **It brings no delete with it**, as nothing on this port does; the objects
 * stay, unreferenced once the console moves on.
 */
export function mintPreviewKey(side: PreviewSide, extension: string): string {
  return `preview/${randomUUID()}-${side}.${extension}`;
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

/**
 * `avatars/<uuid>.<ext>` — **`mintArtworkKey`'s rule, one prefix over**, for the picture a member
 * puts beside their own name (docs/project/prd.md 3.1.12).
 *
 * The same image vocabulary as a cover, deliberately: an avatar is re-encoded in the browser to the
 * same WebP a cover is, checked against the same ceiling, and named by the same table — so there is
 * one answer to "what is an image this product stores" rather than two. Its own prefix because it
 * is its own kind of thing: an operator reading the bucket should be able to tell a study's face
 * from a person's without opening either.
 *
 * **It brings the port's one delete with it** — {@link MediaStore.deleteAvatar}, confined to this
 * prefix. Replacing an avatar or removing one from the profile still repoints the account and
 * leaves the object where it is, as every other upload does; it is deleting the *account* that
 * takes the picture out of the store, because a person who has left is owed that and a person
 * who changed their picture is not.
 */
export function mintAvatarKey(contentType: string): string {
  const extension = extensionForArtworkType(contentType);
  if (extension === null) {
    throw new Error(`no accepted avatar extension for content type "${contentType}"`);
  }
  return `${AVATAR_KEY_PREFIX}${randomUUID()}.${extension}`;
}

/** A note image's key: the prefix the delete is confined to, a uuid, and the format's extension. */
export function mintNoteImageKey(contentType: string): string {
  const extension = extensionForArtworkType(contentType);
  if (extension === null) {
    throw new Error(`no accepted note image extension for content type "${contentType}"`);
  }
  return `${NOTE_IMAGE_KEY_PREFIX}${randomUUID()}.${extension}`;
}
