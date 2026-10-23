import { DownloadsSection } from './downloads-section';
import styles from '../profile.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/profile/downloads` — what this device holds for this account ([3.18.10](docs/project/prd.md)).
 *
 * A section beside Settings, in the shape `settings/page.tsx` set: the `<h2>` under the layout's
 * *My profile*, a sentence of lead, and the list. Everything it shows is read from the device, not
 * the server — a download is a fact about this phone, and the server knows only which ids the
 * last sync asked about.
 */
export default function ProfileDownloadsPage() {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Downloads</h2>
        <p className={styles.pageLead}>Teachings kept on this device, for listening without a connection.</p>
      </header>
      <DownloadsSection />
    </>
  );
}
