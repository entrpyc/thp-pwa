'use client';

import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **The offline and pending-sync banner** ([3.18.16](docs/project/prd.md)).
 *
 * One banner, docked **directly under the transport bar** at the bottom edge — in the same fixed
 * column as the bar, so the two move together and the banner stands alone at the edge while
 * nothing is playing. The operator's decision: it was two strips at the top of the page, one for
 * being offline and one for the count waiting to sync, and the two said one thing twice.
 *
 * What it says, in order of what matters most:
 *
 * - Offline with changes waiting: *You are offline. N changes waiting to sync when you are back
 *   online.* — left-aligned, a sentence to read.
 * - Offline with nothing waiting: *You are offline.* — centred, a state to notice.
 * - Online with the outbox flushing, or still holding something the flush has not reached: the
 *   sync alone, centred, so a note written offline is never silently in limbo.
 *
 * Nothing while online with nothing to sync: the ordinary connected screen is unchanged.
 */
export function OfflineBanner() {
  const offline = useOffline();

  let text: string | null = null;
  let centred = true;
  const changes = `${offline.pending} ${offline.pending === 1 ? 'change' : 'changes'}`;
  if (!offline.online) {
    if (offline.pending > 0) {
      text = `You are offline. ${changes} waiting to sync when you are back online.`;
      centred = false;
    } else {
      text = 'You are offline.';
    }
  } else if (offline.syncing) {
    text = 'Syncing what you did offline…';
  } else if (offline.pending > 0) {
    text = `${changes} waiting to sync.`;
  }

  if (text === null) return null;

  return (
    <p
      className={centred ? `${styles.banner} ${styles.bannerCentred}` : styles.banner}
      role="status"
      aria-live="polite"
      aria-label="Offline status"
    >
      {text}
    </p>
  );
}
