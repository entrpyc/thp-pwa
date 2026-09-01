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
 * - **The hero band is the series' cover**, the column's width and 3:1 as the reference draws it, fading
 *   into the page at its foot and carrying the back control over it (scope prd 3.2.2, 3.2.7). A
 *   series with no cover keeps the flat `--color-bg-deep` strip the band was before covers
 *   arrived — nothing is drawn for artwork that does not exist (scope prd 3.2.6).
 * - **No tab strip.** The reference draws five tabs — `Recordings`, `Scripture`, `Notes`,
 *   `Transcript`, `Mindmap` — and only the first has anything behind it here. A series page has one
 *   thing to show and needs no strip to show it, so the strip is dropped whole rather than rendered
 *   holding one tab.
 * - **No *Search recordings* box** ([§3.10](docs/project/prd.md)), **no download control** on the
 *   header or on any row, and **no per-row duration** — nothing in this epic inspects the media.
 * - **`2h 14m total` is the date range**, which is what [3.3.5](docs/project/prd.md) actually asks
 *   for. See {@link seriesMeta}.
 *
 * **The rows read newest recorded first**, as the library's do — [3.3.1](docs/project/prd.md) is
 * the product's one answer to "what is most recent" and a series is no exception to it. **The
 * numbering still counts the study forwards**, so the list runs `NN`…`01` downwards: a teaching's
 * number is its place in the study, and it would mean nothing if it moved because the list is read
 * from the other end. The number is computed from the row's position in the order the API sent and
 * is stored nowhere.
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

/**
 * `01`, `02` … `12`. Two digits, as the reference numbers them.
 *
 * Counted from the foot of the list rather than the top, because the API sends the rows newest
 * first and the number is the recording's place in the study: the oldest is `01` wherever it is
 * drawn.
 */
function position(index: number, total: number): string {
  return String(total - index).padStart(2, '0');
}

export function SeriesScreen({ seriesId }: { seriesId: string }) {
  const [payload, setPayload] = useState<SeriesPayload | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useBreadcrumbTrail(payload?.series.title ?? null);

  /**
   * The band is drawn before the payload arrives — it holds the back control, which has to be
   * pressable while the series is still loading — so the cover is read defensively here rather
   * than inside the branch that renders the rest of the screen.
   */
  const cover = payload?.series.artworkUrl ?? null;

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
      <div
        className={`${styles.hero}${cover === null ? '' : ` ${styles.heroCovered}`}`}
      >
        {/*
          The cover behind the back control, and nothing at all when there is none (scope prd
          3.2.6). No alternative text: the series title is the `h1` immediately below it, and 4.3
          rules out saying it twice.
        */}
        {cover === null ? null : (
          <>
            <img className={styles.heroArt} src={cover} alt="" />
            <span className={styles.heroFade} aria-hidden="true" />
          </>
        )}
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
                    {position(index, payload.recordings.length)}.
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
