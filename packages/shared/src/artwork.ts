/**
 * **Series cover artwork, as the three consumers spell it** (scope prd 3.1; scope tdd 1.1).
 *
 * The same shape `recordings.ts` gives audio uploads, one media kind over: one table mapping an
 * accepted content type to the extension a minted key ends in, and both directions of it derived
 * from that table rather than restated. The screen refuses a file against this vocabulary before
 * any grant is asked for, the API refuses the declared type against it, and the store's own
 * metadata is checked against it a third time at finalisation — so the three cannot disagree about
 * what an image is.
 *
 * **Three formats, and WebP is the one that is ever produced.** JPEG and PNG are accepted because
 * that is what an admin has on disk; the browser re-encodes whatever it is given to WebP before a
 * byte is sent (scope prd 3.1.2), so `image/webp` is the type nearly every real grant is signed
 * for. The other two are here because the port must be able to name a key for anything it will
 * sign, and because a re-encode that fails is not a case this scope handles.
 */

/**
 * **4 MB, and it is a limit the upload is checked against rather than one the re-encode forces**
 * (scope prd 3.1.9).
 *
 * Unlike the audio ceiling this is not mainly a limit on what a person may choose — the console
 * re-encodes whatever they picked to a bounded WebP before anything is sent, so a 40 MB camera JPEG
 * becomes a legal upload rather than a refusal. What the ceiling is for is the two checks either
 * side of an upload nobody watched: the declared size in the grant, and the store's own metadata at
 * finalisation.
 *
 * **It was 2 MB, and the build moved it.** A worst-case image — pseudo-random pixels, which no
 * lossy codec can compress — re-encoded to 3 MB at 2000 px, and the API refused its own console's
 * upload. 4 MB clears every ordinary cover by a wide margin. It is still not a *guarantee*: no fixed
 * ceiling is, because entropy beats any of them, and an image that exceeds it is refused with the
 * reason on screen rather than stored. That gap is accepted rather than closed.
 */
export const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

/** The ceiling as a person reads it. One statement, so the screen and the API say the same words. */
export const MAX_ARTWORK_LABEL = '4 MB';

/** Every accepted image content type, and the extension a key for it ends in. */
export const ACCEPTED_ARTWORK_FORMATS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const;

export type ArtworkContentType = keyof typeof ACCEPTED_ARTWORK_FORMATS;

export const ACCEPTED_ARTWORK_TYPES = Object.keys(
  ACCEPTED_ARTWORK_FORMATS,
) as readonly ArtworkContentType[];

/** The formats as a person reads them, for the sentence the console prints when it refuses one. */
export const ACCEPTED_ARTWORK_LABEL = 'JPEG, PNG or WebP';

export function isAcceptedArtworkType(value: unknown): value is ArtworkContentType {
  return (
    typeof value === 'string' &&
    (ACCEPTED_ARTWORK_TYPES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

/**
 * The extension a minted key ends in for this content type, or `null` when nothing accepts it.
 *
 * Deliberately **not** tolerant of the spellings the audio table tolerates. `image/jpg` is not a
 * content type any browser reports for a file it picked, so accepting it here would widen what the
 * store can hold on the strength of a request nobody legitimate makes.
 */
export function extensionForArtworkType(contentType: string): string | null {
  const wanted = contentType.trim().toLowerCase();
  return isAcceptedArtworkType(wanted) ? ACCEPTED_ARTWORK_FORMATS[wanted] : null;
}
