'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_SERIES_PATH,
  seriesPagePath,
  type SeriesListPayload,
  type SeriesView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from '../screens.module.css';

/**
 * **The series listing** — `pages/series-listing.png`.
 *
 * The reference, read against what this epic has:
 *
 * - **The artwork thumbnail is dropped**, not rendered as an empty box.
 *   [3.3.3](docs/project/prd.md) is deferred, and the row is rebalanced without it — which is the
 *   same move the library made from this same reference. What survives is the layout: a page title,
 *   one sentence under it, then rounded rows with a chevron.
 * - **The row gains its count and date range**, where the reference has only a title. That is the
 *   half of [3.3.5](docs/project/prd.md) a listing can carry, and it is what tells a member whether
 *   a study is four teachings or forty before they open it.
 * - **No description on the row.** The reference does not print one here, and the series page
 *   does — a listing is a scan.
 *
 * **What a member sees is series holding at least one published teaching, and no other.** A series
 * nobody has published anything in has nothing to open, so it is absent rather than empty; the
 * console is where an empty series is visible, because the console is where it gets filled.
 *
 * **This is the member surface, whatever the caller's role**, exactly as the library is: an admin
 * browsing here sees what a member sees, and what makes that true is one boolean on the read rather
 * than anything on this screen.
 */

/** One fixed rendering of a date, matching the library's and the console's. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/**
 * `8 recordings · 12 Mar 2025 – 4 Jun 2025`.
 *
 * **This is what `pages/series-inner.png`'s `2h 14m total` becomes**, and it is not a substitution
 * of convenience: [3.3.5](docs/project/prd.md) names title, description, date range and count as
 * what a series carries, running time is not on that list, and this epic stores no duration
 * anywhere. A series holding one recording prints that one date rather than the same date twice.
 */
export function seriesMeta(series: SeriesView): string {
  const count = `${series.recordingCount} ${series.recordingCount === 1 ? 'recording' : 'recordings'}`;
  const { firstRecordedAt, lastRecordedAt } = series;
  if (firstRecordedAt === null || lastRecordedAt === null) return count;
  const range =
    firstRecordedAt === lastRecordedAt
      ? formatDay(firstRecordedAt)
      : `${formatDay(firstRecordedAt)} – ${formatDay(lastRecordedAt)}`;
  return `${count} · ${range}`;
}

export function SeriesListing() {
  const [series, setSeries] = useState<readonly SeriesView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<SeriesListPayload>(MEMBER_SERIES_PATH, { credentials: 'include' })
      .then((payload) => {
        setSeries(payload.series);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        setSeries(null);
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.',
        );
      });
  }, []);

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Series</h1>
        <p className={styles.pageLead}>Explore in-depth teachings organized in series.</p>
      </header>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {series === null && failure === null ? (
        <p className={styles.quiet}>Loading series…</p>
      ) : null}

      {series !== null && series.length === 0 ? (
        <p className={styles.quiet}>No series have been published yet.</p>
      ) : null}

      {series !== null && series.length > 0 ? (
        <ul className={styles.rows} aria-label="Series">
          {series.map((one) => (
            <li key={one.id} className={styles.rowGroup}>
              <Link className={styles.row} href={seriesPagePath(one.id)}>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{one.title}</span>
                  <span className={styles.rowMeta}>{seriesMeta(one)}</span>
                </span>
                <span className={styles.rowChevron} aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
