import { HighlightsPlaylist } from './highlights-playlist';

export const dynamic = 'force-dynamic';

/**
 * `/highlights` — the member's Highlights, as a playlist ([3.15.5](docs/project/prd.md),
 * [3.15.6](docs/project/prd.md)). Its own page, reached from the menu and from the dashboard's
 * *View highlights* line; it was a section of the profile until the operator moved it out.
 *
 * Nothing is read here — the list is the member's own and comes over the API, which is what
 * refuses anybody else's ([3.15.9](docs/project/prd.md)).
 */
export default function HighlightsPage() {
  return <HighlightsPlaylist />;
}
