'use client';

import { offlineManager } from '@/client/offline/manager';
import { itemFraction } from '@/client/offline/queue';
import { useOffline } from '@/client/offline/hooks';
import { DownloadIcon } from './download-icon';
import styles from './downloads.module.css';

/**
 * **The recording page's download control** ([3.18.5](docs/project/prd.md), [3.18.8](docs/project/prd.md),
 * [3.18.9](docs/project/prd.md)) — the download icon at the right of the title, by the operator's
 * decision: it was a worded pill under the header until the icon replaced it.
 *
 * One button that reads one of three ways off the manager, through its icon and its label rather
 * than a word beside it: *Download* (the outline), the transfer (a thin bar under the icon, and
 * the press cancels), or the failure (the outline again, the sentence under it, and the press
 * retries). Once the teaching is held the control is **not drawn at all** — the operator's
 * decision; the profile's Downloads page is where a download is removed. A single teaching
 * downloads on one tap — the operator's decision again; "Download all" is the control that asks
 * first. Self-contained so the recording page mounts it on one line and knows nothing about the
 * queue.
 */
export function DownloadControl({ recordingId, title }: { recordingId: string; title: string }) {
  const offline = useOffline();
  const manager = offlineManager();
  const held = offline.downloads.find((one) => one.recordingId === recordingId) ?? null;
  const item = offline.queue.items.find((one) => one.recordingId === recordingId) ?? null;

  // Held: nothing to draw. The profile's Downloads page lists it with its size and removes it.
  if (held !== null) return null;

  if (item !== null && (item.status === 'queued' || item.status === 'downloading')) {
    const fraction = itemFraction(item);
    const percent = Math.round(fraction * 100);
    const progress = item.status === 'queued' ? 'Waiting to download' : `Downloading ${percent}%`;
    return (
      <div className={styles.headerControl} aria-label="Download">
        <button
          className={styles.iconButton}
          type="button"
          aria-label="Cancel"
          title={`${progress} · press to cancel`}
          onClick={() => manager.cancel(recordingId)}
        >
          <DownloadIcon held={false} />
        </button>
        <div
          className={styles.iconTrack}
          role="progressbar"
          aria-label={`Downloading ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className={styles.fill} style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.hiddenText}>{progress}</span>
      </div>
    );
  }

  const failed = item?.status === 'failed';
  return (
    <div className={styles.headerControl} aria-label="Download">
      <button
        className={styles.iconButton}
        type="button"
        disabled={!offline.online}
        aria-label={failed ? 'Try the download again' : 'Download'}
        title={
          !offline.online
            ? 'Downloads need a connection.'
            : failed
              ? (item.failure ?? 'Try the download again')
              : 'Download'
        }
        onClick={() => manager.download(recordingId, title)}
      >
        <DownloadIcon held={false} />
      </button>
      {failed ? <span className={styles.iconNote}>{item.failure}</span> : null}
      {!offline.online ? <span className={styles.iconNote}>Downloads need a connection.</span> : null}
    </div>
  );
}
