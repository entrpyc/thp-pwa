import { notePath } from './notes';

/**
 * **Images on notes** ([3.12.22](docs/project/prd.md)–[3.12.25](docs/project/prd.md)) — a note or a
 * reply can carry up to three pictures: a photo of a page, a whiteboard, a verse underlined.
 *
 * The upload is the product's one image path, reused: the browser shrinks and re-encodes the
 * picture to WebP, asks for a signed upload grant, puts the bytes in the store, and then names the
 * key when it writes the note. The vocabulary of formats and the byte ceiling are `artwork.ts`'s,
 * deliberately — a second image vocabulary would be a second thing the composer and the API could
 * disagree about.
 *
 * What is decided here:
 *
 * 1. **The cap and the ceilings** — how many per note, how long a description may be, how large
 *    the longest edge is made before upload.
 * 2. **The wire shapes** — how a picture is referred to on the way in (by the key the grant named,
 *    or by an existing image's id when editing) and how it is answered (by a signed URL, never a
 *    key).
 * 3. **The pending reference** an offline composer sends: a picture kept on the device until the
 *    outbox flushes, which the server never accepts and the flush always replaces.
 */

/** How many pictures one note or reply may carry. */
export const MAX_NOTE_IMAGES = 3;

/** The optional description read to a screen reader in the picture's place. */
export const MAX_NOTE_IMAGE_ALT_LENGTH = 200;

/**
 * The longest edge a note image is brought down to before it leaves the device. A phone photo is
 * four thousand pixels and twelve megabytes; at sixteen hundred it is a few hundred kilobytes and
 * still reads on a tablet, and the notes list draws it at a thumbnail anyway.
 */
export const NOTE_IMAGE_MAX_EDGE = 1600;

/** `POST` — the grant half of an upload. Not under a recording: the picture is not a note yet. */
export const NOTE_IMAGE_UPLOADS_PATH = '/notes/images/uploads';

/** `DELETE` — take one picture off a note: the author's own, or any by an admin ([3.12.24](docs/project/prd.md)). */
export function noteImagePath(noteId: string, imageId: string): string {
  return `${notePath(noteId)}/images/${imageId}`;
}

/**
 * How the body of a write refers to a picture.
 *
 * - `key` — an upload the grant named and the bytes have landed behind. The server believes the
 *   store, not the request: it reads the object back before writing the row.
 * - `id` — an image the note already carries, kept through an edit. Its description may change.
 * - `pending` — a picture an offline composer kept on the device. **The server refuses it**; it
 *   exists so the outbox can carry the note until the flush uploads the bytes and swaps in a key.
 *
 * The description travels on every shape, trimmed and optional; `null` and `''` both mean none.
 */
export type NoteImageRef =
  | { readonly key: string; readonly alt?: string | null }
  | { readonly id: string; readonly alt?: string | null }
  | { readonly pending: string; readonly alt?: string | null };

export function isPendingImageRef(ref: NoteImageRef): ref is { readonly pending: string; readonly alt?: string | null } {
  return 'pending' in ref;
}

/** One picture as a note is answered with it. A signed grant to the object, never the key. */
export interface NoteImageView {
  readonly id: string;
  readonly url: string;
  /** The member's description, or `null`; the client announces "Image N of M" in its place. */
  readonly alt: string | null;
}

/**
 * The word a notification or an excerpt uses for a note that has pictures and no words
 * ([3.12.23](docs/project/prd.md)): "Ana replied to your note — Photo".
 */
export function excerptForImages(count: number): string {
  return count === 1 ? 'Photo' : `${count} photos`;
}

/** The accessible name of one picture in a strip, when its author described nothing. */
export function imageFallbackAlt(index: number, count: number): string {
  return count === 1 ? 'Image' : `Image ${index + 1} of ${count}`;
}
