import { mediaStore, type MediaStore } from '@thp/media';
import { PREVIEW_GRANT_SECONDS } from '@thp/shared';

/**
 * **The one place a preview excerpt's URLs are minted** ([3.4.6](docs/project/prd.md)).
 *
 * The third kind of media the product signs, after audio (`mintPlaybackGrant`) and covers
 * (`mintArtworkGrant`), and one function for the reason each of those is: what a signed preview
 * URL is signed for — its expiry, whether it may be cached — is a fact about this file, and the
 * day it changes there is one function to change. `playback.test.ts` counts the callers of
 * `presignGet` across the web package and refuses a fourth.
 *
 * **It authorises nothing.** The keys come off a job row the caller has already been allowed to
 * read; what this adds is the boundary property the other two have — the console is handed two
 * short-lived grants rather than two keys, and the bytes go from the store to the browser
 * directly.
 *
 * Fresh every read and never stored, exactly as playback's are: an hour is the playback figure,
 * and a grant copied out of a network tab should die with the sitting.
 *
 * The store is an argument with a default rather than a lookup, so the expiry can be asserted
 * against a recording port instead of against the clock.
 */
export async function mintPreviewGrant(
  keys: { readonly beforeKey: string; readonly afterKey: string },
  store?: MediaStore,
): Promise<{ readonly before: string; readonly after: string; readonly expiresAt: string }> {
  const expiresAt = new Date(Date.now() + PREVIEW_GRANT_SECONDS * 1000);
  const signer = store ?? mediaStore();
  const [before, after] = await Promise.all([
    signer.presignGet({ key: keys.beforeKey, expiresInSeconds: PREVIEW_GRANT_SECONDS }),
    signer.presignGet({ key: keys.afterKey, expiresInSeconds: PREVIEW_GRANT_SECONDS }),
  ]);
  return { before, after, expiresAt: expiresAt.toISOString() };
}
