import { SETTINGS_SECTIONS } from './sections';
import styles from '../profile.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/profile/settings` — what concerns only the account's owner, one card per section.
 *
 * The first section beside the identity page, and the model for the ones to come: the page is the
 * `<h2>` under the layout's *My profile*, a sentence of lead, and then `SETTINGS_SECTIONS` in order.
 * It holds no state of its own — each card is a client component that talks to its own route — so
 * adding a card is a file and a list entry (see `sections.ts`), never an edit here.
 */
export default function ProfileSettingsPage() {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Settings</h2>
        <p className={styles.pageLead}>Your account on this device. Nothing here is shown to others.</p>
      </header>

      {SETTINGS_SECTIONS.map(({ id, Section }) => (
        <Section key={id} />
      ))}
    </>
  );
}
