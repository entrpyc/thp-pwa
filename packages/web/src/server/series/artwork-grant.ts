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
 * **A day, and the same URL all day** — unlike playback, which is an hour and fresh every time.
 *
 * A cover is on every listing row, every hero band and the transport's tile, and a member sees the
 * same handful of covers on every page they open. Signed afresh per page, each one is a new URL
 * the browser has never seen, so it is fetched again and painted from nothing on every navigation
 * — which reads from the screen as the pictures flashing. Signed as of the start of the day and
 * carrying a `Cache-Control` for the day, the same cover is the same URL on every page until
 * midnight, and the browser paints it from its own cache.
 *
 * The cost is that a URL copied out of a network tab stays live for up to two days rather than an
 * hour. A cover is member-exclusive content behind the same login the audio is, but it is a
 * picture of a study rather than the teaching itself, and a still-frame is what a member could
 * screenshot anyway — which is why the trade is taken here and not for audio.
 */
export const ARTWORK_CACHE_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Twice the window, which is the least the store accepts for a cacheable grant: a URL minted a
 * second before midnight has to be honoured for the whole of the following day, because that is
 * how long the browser was told it may keep the picture.
 */
export const ARTWORK_GRANT_SECONDS = ARTWORK_CACHE_WINDOW_SECONDS * 2;

export async function mintArtworkGrant(
  key: string | null,
  store: MediaStore = mediaStore(),
): Promise<string | null> {
  // No cover is the ordinary state (scope prd 3.1.7), and it costs no signature: the store is not
  // asked, and what the surface gets is `null` rather than a URL to nothing.
  if (key === null) return null;
  return store.presignGet({
    key,
    expiresInSeconds: ARTWORK_GRANT_SECONDS,
    cache: { windowSeconds: ARTWORK_CACHE_WINDOW_SECONDS },
  });
}
