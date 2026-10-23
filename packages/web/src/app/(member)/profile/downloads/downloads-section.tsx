'use client';

import Link from 'next/link';
import { describeBytes, recordingPagePath } from '@thp/shared';
import { offlineManager } from '@/client/offline/manager';
import { useOffline } from '@/client/offline/hooks';
import styles from '../../downloads/downloads.module.css';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/**
 * **The downloads list** ([3.18.10](docs/project/prd.md), [3.18.11](docs/project/prd.md)) — every
 * teaching held on this device for this account: title, series, size and the date it was
 * downloaded, a delete per row, and the total in use. Read straight off the manager, so a delete
 * here and the mark on a library row cannot disagree.
 */
export function DownloadsSection() {
  const offline = useOffline();
  const manager = offlineManager();

  if (!offline.ready) return <p className={styles.quiet}>Loading…</p>;

  return (
    <>
      <p className={styles.total}>
        {offline.downloads.length === 0
          ? 'Nothing is downloaded on this device.'
          : `${offline.downloads.length} ${offline.downloads.length === 1 ? 'teaching' : 'teachings'} · ${describeBytes(offline.totalBytes)} on this device`}
        {offline.storeKind === 'browser' && offline.freeBytes !== null
          ? ` · ${describeBytes(offline.freeBytes)} free`
          : ''}
      </p>

      {offline.downloads.length === 0 ? null : (
        <ul className={styles.rows} aria-label="Downloads">
          {offline.downloads.map((one) => (
            <li key={one.key} className={styles.rowGroup}>
              <div className={styles.rowActions}>
                <Link className={styles.rowText} href={recordingPagePath(one.recordingId)}>
                  <span className={styles.rowTitle}>{one.title}</span>
                  <span className={styles.rowMeta}>
                    {one.seriesTitle === null ? 'No series' : one.seriesTitle} · {describeBytes(one.bytes)} ·
                    Downloaded {formatDay(one.downloadedAt)}
                  </span>
                </Link>
                <button
                  className={styles.secondary}
                  type="button"
                  aria-label={`Delete download of ${one.title}`}
                  onClick={() => void manager.remove(one.recordingId)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
