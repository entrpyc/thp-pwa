'use client';

import { useState } from 'react';
import { describeBytes } from '@thp/shared';
import { ApiClientError } from '@/client/api-client';
import { offlineManager } from '@/client/offline/manager';
import type { SeriesPlan } from '@/client/offline/queue';
import { useOffline } from '@/client/offline/hooks';
import styles from './downloads.module.css';

/**
 * **"Download all" on the series page** ([3.18.6](docs/project/prd.md), [3.18.17](docs/project/prd.md);
 * project tdd 5.8).
 *
 * The press sizes the series up and opens a sheet rather than queueing: the operator's decision is
 * that a series asks first, because it can be a gigabyte on a metered plan. The sheet says what
 * the series needs and, on the browser route, what the device has free; when the whole series
 * does not fit it says so and offers the most recent recordings that do, exactly as 3.18.17
 * words it. In a store build there is no free-space figure and the sheet is the confirmation
 * alone. What is already held or queued is not asked for again.
 *
 * Self-contained, so the series page imports it on one line.
 */
export function DownloadAllControl({ seriesId }: { seriesId: string }) {
  const offline = useOffline();
  const manager = offlineManager();
  const [plan, setPlan] = useState<SeriesPlan | null>(null);
  const [sizing, setSizing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function open(): Promise<void> {
    setSizing(true);
    setFailure(null);
    try {
      setPlan(await manager.planSeries(seriesId));
    } catch (caught) {
      setFailure(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not size up the series. Check your connection and try again.',
      );
    } finally {
      setSizing(false);
    }
  }

  function confirm(items: SeriesPlan['offered']): void {
    manager.downloadMany(items.map((one) => ({ id: one.id, title: one.title, bytes: one.bytes })));
    setPlan(null);
  }

  return (
    <div className={styles.control}>
      <button
        className={styles.pill}
        type="button"
        disabled={!offline.online || sizing}
        onClick={() => void open()}
      >
        <span aria-hidden="true">↓</span>
        {sizing ? 'Sizing up…' : 'Download all'}
      </button>
      {failure === null ? null : <span className={styles.rowMeta}>{failure}</span>}

      {plan === null ? null : (
        <div className={styles.scrim} role="presentation" onClick={() => setPlan(null)}>
          <div
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="download-all-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className={styles.cardTitle} id="download-all-title">
              Download all
            </h2>
            {plan.wanted.length === 0 ? (
              <p className={styles.quiet}>Every recording in this series is already downloaded.</p>
            ) : plan.fits ? (
              <>
                <p className={styles.quiet}>
                  {plan.wanted.length === 1 ? 'One recording' : `${plan.wanted.length} recordings`},{' '}
                  {describeBytes(plan.neededBytes)}
                  {plan.availableBytes === null ? '' : ` · ${describeBytes(plan.availableBytes)} free on this device`}.
                </p>
                <div className={styles.actions}>
                  <button className={styles.primary} type="button" onClick={() => confirm(plan.wanted)}>
                    Download {describeBytes(plan.neededBytes)}
                  </button>
                  <button className={styles.secondary} type="button" onClick={() => setPlan(null)}>
                    Not now
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={styles.failure} role="status">
                  This series needs {describeBytes(plan.neededBytes)} and this device has{' '}
                  {describeBytes(plan.availableBytes ?? 0)} available.
                </p>
                {plan.offered.length === 0 ? (
                  <p className={styles.quiet}>Not even the most recent recording fits. Free some space first.</p>
                ) : (
                  <>
                    <p className={styles.quiet}>
                      The {plan.offered.length === 1 ? 'most recent recording fits' : `${plan.offered.length} most recent recordings fit`}:
                    </p>
                    <ul className={styles.sheetList}>
                      {plan.offered.map((one) => (
                        <li key={one.id}>
                          {one.title} · {describeBytes(one.bytes)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className={styles.actions}>
                  {plan.offered.length === 0 ? null : (
                    <button className={styles.primary} type="button" onClick={() => confirm(plan.offered)}>
                      Download {plan.offered.length === 1 ? 'the most recent' : `these ${plan.offered.length}`}
                    </button>
                  )}
                  <button className={styles.secondary} type="button" onClick={() => setPlan(null)}>
                    Not now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
