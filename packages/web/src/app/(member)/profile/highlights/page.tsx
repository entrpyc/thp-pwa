import { HighlightsPlaylist } from './highlights-playlist';
import styles from '../profile.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/profile/highlights` — the member's Highlights, as a playlist ([3.15.5](docs/project/prd.md),
 * [3.15.6](docs/project/prd.md)).
 *
 * A section beside Settings, on the model `settings/page.tsx` set: the `<h2>` under the layout's
 * *My profile*, a sentence of lead, and one client component that talks to its own route. Nothing
 * is read here — the list is the member's own and comes over the API, which is what refuses
 * anybody else's ([3.15.9](docs/project/prd.md)).
 */
export default function ProfileHighlightsPage() {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Highlights</h2>
        <p className={styles.pageLead}>
          The teachings, moments and notes you pinned. Only you can see this list.
        </p>
      </header>

      <HighlightsPlaylist />
    </>
  );
}
