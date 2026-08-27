import { NowPlayingScreen } from './now-playing-view';

export const dynamic = 'force-dynamic';

/**
 * `/now-playing` — the expanded playback surface of `pages/player.png` (scope prd 3.3.1).
 *
 * **A route inside the member layout**, which is the whole of scope tdd 1.6: the layout mounts the
 * player provider, the docked transport and the `<audio>` element it owns, so navigating here
 * re-renders this slot and touches none of them. The layout checks the session; this is the
 * composition, exactly as the other member pages are.
 *
 * **No id in the address.** What the view shows is the one playback session the transport already
 * holds, so there is nothing to read from the URL and nothing to fetch here — the view takes what
 * is playing from the client-side player context (scope tdd 1.7).
 */
export default function NowPlayingPage() {
  return <NowPlayingScreen />;
}
