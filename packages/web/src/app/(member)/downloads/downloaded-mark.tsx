'use client';

import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **The downloaded mark** ([3.18.9](docs/project/prd.md)) — a small outlined tick wherever a
 * teaching appears: the library's rows (the series page's rows and the landing's resume card
 * carried it too, until the operator took it off both). Renders nothing for a
 * teaching that is not held, so a row costs nothing until it is. A span, never a link, because it
 * sits inside rows that are whole-row links.
 */
export function DownloadedMark({ recordingId }: { recordingId: string }) {
  const offline = useOffline();
  if (!offline.downloads.some((one) => one.recordingId === recordingId)) return null;
  return (
    <span className={styles.mark} aria-label="Downloaded">
      <span className={styles.markIcon} aria-hidden="true">
        ✓
      </span>
      Downloaded
    </span>
  );
}
