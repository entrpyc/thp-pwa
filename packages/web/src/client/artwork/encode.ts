import { ACCEPTED_ARTWORK_LABEL, isAcceptedArtworkType } from '@thp/shared';

/**
 * **The re-encode, and it happens in the browser** (scope prd 3.1.2; scope tdd 1.2).
 *
 * A canvas decode, a resize to the bound below, and a WebP encode — all before the upload grant is
 * asked for. Nothing on the server and nothing in the worker gains an image dependency, no job
 * enters the ledger, and no series is ever left with a cover the pipeline has not caught up to.
 *
 * **What is stored is this output and not the file the admin chose.** That is the cost, it is
 * written down in `docs/scope/prd.md` § 5, and it is what buys a single object with no rendition
 * state behind it: one image under the ceiling serves the listing thumbnail, both hero bands and
 * the square.
 *
 * **The shape survives.** Accepting any image was chosen over enforcing the square that podcast
 * artwork will eventually want (project prd 5.3.2), so a landscape cover comes out landscape and
 * the surfaces crop it. Squaring here would impose that shape by the back door.
 */

/**
 * 2000 px on the longest edge.
 *
 * Generous enough that a square upload survives at a resolution project prd 5.3.2 would accept when
 * distribution arrives, small enough that the result is usually well under the 4 MB ceiling and
 * cheap to send to a phone painting a small thumbnail. **Usually, not always** — an image of high
 * visual entropy can still re-encode past the ceiling at this size and be refused, which is scope
 * prd 3.1.9 and is why the ceiling was raised from 2 MB rather than this bound being lowered.
 */
export const ARTWORK_MAX_EDGE = 2000;

/** The one format ever produced, whatever went in. */
export const ARTWORK_OUTPUT_TYPE = 'image/webp';

/**
 * The quality WebP is encoded at. High enough that a photographic cover holds up behind a title at
 * full width; low enough that 2000 px of it is normally a fraction of the 4 MB ceiling. Fixed —
 * the encoder does not retry at a lower quality to fit, which was the operator's call (scope prd
 * 3.1.9).
 */
const ARTWORK_QUALITY = 0.82;

/**
 * The dimensions `width × height` becomes: unchanged when it already fits, otherwise scaled so the
 * longest edge is `maxEdge` and the aspect ratio is what it was.
 *
 * Pure, and separate from everything around it, because it is the only part of this file a test can
 * reach outside a browser — and because it is the part carrying the decision rather than the
 * plumbing. Neither edge is allowed to round to zero: a panorama scaled to 2000 wide would floor
 * its height to nothing, and a canvas of zero height decodes to nothing at all.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = ARTWORK_MAX_EDGE,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface EncodedArtwork {
  readonly blob: Blob;
  readonly contentType: string;
}

/**
 * `null` when this file may be sent, otherwise one sentence saying why it may not.
 *
 * Read **before anything is encoded and before any grant is asked for**, so a file the product does
 * not accept costs a press rather than a round trip — the same rule `checkChosenFile` holds for
 * audio, and the API asks the same question of the declared type a second time.
 */
export function checkChosenArtwork(file: File): string | null {
  return isAcceptedArtworkType(file.type)
    ? null
    : `That is not an image this accepts. Upload ${ACCEPTED_ARTWORK_LABEL}.`;
}

/**
 * Decode, resize and re-encode to one bounded WebP.
 *
 * `createImageBitmap` rather than an `<img>` and a load event: it decodes off the main thread and
 * it refuses a file that is not really an image, which is the one check a content type cannot make.
 */
export async function encodeArtwork(file: File): Promise<EncodedArtwork> {
  const source = await createImageBitmap(file);
  const { width, height } = fitWithin(source.width, source.height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser gave no 2d canvas context');
  context.drawImage(source, 0, 0, width, height);
  source.close();

  const blob = await new Promise<Blob | null>((done) => {
    canvas.toBlob(done, ARTWORK_OUTPUT_TYPE, ARTWORK_QUALITY);
  });
  if (blob === null) throw new Error('this browser encoded no image');

  return { blob, contentType: ARTWORK_OUTPUT_TYPE };
}
