'use client';

import { describeBytes } from '@thp/shared';
import { offlineManager } from '@/client/offline/manager';
import { itemFraction } from '@/client/offline/queue';
import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **The recording page's download control** ([3.18.5](docs/project/prd.md), [3.18.8](docs/project/prd.md),
 * [3.18.9](docs/project/prd.md)).
 *
 * One pill in the tab strip's shape, and it reads one of four ways off the manager: *Download*,
 * the transfer with its bar and percentage, *Downloaded* with a way to remove it, or the failure
 * sentence with a retry. A single teaching downloads on one tap — the operator's decision for this
 * ticket; "Download all" is the control that asks first. Self-contained so the recording page
 * imports it on one line and knows nothing about the queue.
 */
export function DownloadControl({ recordingId, title }: { recordingId: string; title: string }) {
  const offline = useOffline();
  const manager = offlineManager();
  const held = offline.downloads.find((one) => one.recordingId === recordingId) ?? null;
  const item = offline.queue.items.find((one) => one.recordingId === recordingId) ?? null;

  if (held !== null) {
    return (
      <div className={styles.control} aria-label="Download">
        <span className={styles.mark}>
          <span className={styles.markIcon} aria-hidden="true">
            ✓
          </span>
          Downloaded · {describeBytes(held.bytes)}
        </span>
        <button className={styles.dismiss} type="button" onClick={() => void manager.remove(recordingId)}>
          Remove download
        </button>
      </div>
    );
  }

  if (item !== null && (item.status === 'queued' || item.status === 'downloading')) {
    const fraction = itemFraction(item);
    const percent = Math.round(fraction * 100);
    return (
      <div className={styles.control} aria-label="Download">
        <span className={styles.rowMeta}>
          {item.status === 'queued' ? 'Waiting to download' : `Downloading ${percent}%`}
        </span>
        <div
          className={styles.track}
          role="progressbar"
          aria-label={`Downloading ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className={styles.fill} style={{ width: `${percent}%` }} />
        </div>
        <button className={styles.dismiss} type="button" onClick={() => manager.cancel(recordingId)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className={styles.control} aria-label="Download">
      <button
        className={styles.pill}
        type="button"
        disabled={!offline.online}
        onClick={() => manager.download(recordingId, title)}
      >
        <span aria-hidden="true">↓</span>
        {item?.status === 'failed' ? 'Try the download again' : 'Download'}
      </button>
      {item?.status === 'failed' ? <span className={styles.rowMeta}>{item.failure}</span> : null}
      {!offline.online ? <span className={styles.rowMeta}>Downloads need a connection.</span> : null}
    </div>
  );
}
