'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_SERIES_PAGE_PATH,
  formatTimecode,
  memberSeriesPath,
  recordingPagePath,
  type SeriesPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../../player-context';
import { seriesMeta } from '../series-listing';
import styles from '../../screens.module.css';

/**
 * **One series** — `pages/series-inner.png`.
 *
 * The reference draws a screen this epic has almost none of, and every absence is a deferral with
 * a named home rather than an omission:
 *
 * - **The hero artwork becomes a flat `--color-bg-deep` band** carrying the back control, exactly
 *   as the recording page's did. [3.3.3](docs/project/prd.md) is deferred and the band keeps the
 *   slot, so a cover drops into it later without moving anything below it.
 * - **No tab strip.** The reference draws five tabs — `Recordings`, `Scripture`, `Notes`,
 *   `Transcript`, `Mindmap` — and only the first has anything behind it here. A series page has one
 *   thing to show and needs no strip to show it, so the strip is dropped whole rather than rendered
 *   holding one tab.
 * - **No *Search recordings* box** ([§3.10](docs/project/prd.md)), **no download control** on the
 *   header or on any row, and **no per-row duration** — nothing in this epic inspects the media.
 * - **`2h 14m total` is the date range**, which is what [3.3.5](docs/project/prd.md) actually asks
 *   for. See {@link seriesMeta}.
 *
 * **The rows read forwards.** Oldest recorded first, numbered `01`…`NN` — the opposite of the
 * library's newest-first, and both are correct: [3.3.1](docs/project/prd.md) makes newest-first the
 * product's default reading and [3.3.4](docs/project/prd.md) asks for chronological inside a
 * series, because a study is read forwards. The number is the row's position in the order the API
 * sent and is stored nowhere.
 *
 * **Progress is read here and never written.** A started row prints *Resume at 12:34* where the
 * reference prints a duration; an unstarted one prints the date it was recorded. There is no
 * percentage and no bar, because a percentage needs a total this epic deliberately does not store.
 * The player remains the only writer of a position.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/** `01`, `02` … `12`. Two digits, as the reference numbers them. */
function position(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function SeriesScreen({ seriesId }: { seriesId: string }) {
  const [payload, setPayload] = useState<SeriesPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useBreadcrumbTrail(payload?.series.title ?? null);

  useEffect(() => {
    let live = true;

    void apiFetch<SeriesPayload>(memberSeriesPath(seriesId), { credentials: 'include' })
      .then((found) => {
        if (!live) return;
        setPayload(found);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setPayload(null);
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.',
        );
      });

    return () => {
      live = false;
    };
  }, [seriesId]);

  return (
    <>
      <div className={styles.hero}>
        <Link className={styles.back} href={MEMBER_SERIES_PAGE_PATH} aria-label="Back to series">
          <span aria-hidden="true">‹</span>
        </Link>
      </div>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {payload === null ? (
        failure === null ? (
          <p className={styles.quiet}>Loading the series…</p>
        ) : null
      ) : (
        <>
          <header className={styles.detailText}>
            <h1 className={styles.detailTitle}>{payload.series.title}</h1>
            {payload.series.description === null ? null : (
              <p className={styles.seriesDescription}>{payload.series.description}</p>
            )}
            <p className={styles.detailMeta}>{seriesMeta(payload.series)}</p>
          </header>

          <ul className={styles.rows} aria-label="Recordings">
            {payload.recordings.map((recording, index) => (
              <li key={recording.id} className={styles.rowGroup}>
                <Link className={styles.row} href={recordingPagePath(recording.id)}>
                  <span className={styles.rowNumber} aria-hidden="true">
                    {position(index)}.
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>{recording.title}</span>
                    {recording.description === null ? null : (
                      <span className={styles.rowDescription}>{recording.description}</span>
                    )}
                    <span className={styles.rowMeta}>
                      {recording.positionMs === null
                        ? formatDay(recording.recordedAt)
                        : `Resume at ${formatTimecode(recording.positionMs)}`}
                    </span>
                  </span>
                  <span className={styles.rowChevron} aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
