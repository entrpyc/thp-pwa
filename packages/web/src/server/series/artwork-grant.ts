import { mediaStore, type MediaStore } from '@thp/media';

/**
 * **The one place a cover's URL is minted** (scope tdd 1.4).
 *
 * One function for the reason `mintPlaybackGrant` is one function: every surface in the product
 * that shows a cover reads it through here, so what a signed artwork URL is signed for is a fact
 * about this file rather than about however many call sites happened to agree.
 *
 * **It authorises nothing.** By the time a key reaches it, the response carrying that key has
 * already passed the policy check that decided whether this caller may read the series at all —
 * which is why there is no artwork read action in the policy table (scope tdd 1.5). What this adds
 * is the boundary property: the client is handed a short-lived grant to the object rather than the
 * bytes, and never the key (scope prd 3.1.6, scope prd 4.2).
 *
 * The store is an argument with a default rather than a lookup, so the expiry can be asserted
 * against a recording port instead of against the clock.
 */

/**
 * One hour, the same as playback.
 *
 * A cover is looked at for as long as a page is open, and a page open longer than that re-mints on
 * its next read. What a longer expiry would buy is nothing anybody notices; what it costs is that a
 * URL copied out of a network tab stays live for the afternoon — and a cover is member-exclusive
 * content behind the same login the audio is.
 */
export const ARTWORK_GRANT_SECONDS = 60 * 60;

export async function mintArtworkGrant(
  key: string | null,
  store: MediaStore = mediaStore(),
): Promise<string | null> {
  // No cover is the ordinary state (scope prd 3.1.7), and it costs no signature: the store is not
  // asked, and what the surface gets is `null` rather than a URL to nothing.
  if (key === null) return null;
  return store.presignGet({ key, expiresInSeconds: ARTWORK_GRANT_SECONDS });
}
