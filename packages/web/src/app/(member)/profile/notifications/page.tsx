import { PushSection } from './push-section';
import styles from '../profile.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/profile/notifications` — **push, per category, for this account**
 * ([3.17.13](docs/project/prd.md), [3.17.14](docs/project/prd.md)).
 *
 * The third section beside the identity page, in the shape `settings/page.tsx` set: the `<h2>`
 * under the layout's *My profile*, a sentence of lead, and one card. One card rather than a list
 * of them, because the device and the switches are one decision — a switch is meaningless on a
 * device that cannot be reached, and the card says so in one place. The in-app centre is not
 * mentioned as a setting because it is not one: it receives everything (3.17.13), and the lead
 * says so.
 */
export default function ProfileNotificationsPage() {
  return (
    <>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Notifications</h2>
        <p className={styles.pageLead}>
          Which notifications reach this device. The notification centre behind the bell always
          lists everything, whatever you choose here.
        </p>
      </header>
      <PushSection />
    </>
  );
}
