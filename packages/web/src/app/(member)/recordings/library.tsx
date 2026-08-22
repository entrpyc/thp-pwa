'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_RECORDINGS_PATH,
  recordingPagePath,
  type RecordingListPayload,
  type RecordingView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from '../screens.module.css';

/**
 * **The library** — every published teaching, newest date recorded first.
 *
 * There is no `pages/library.png`. The nearest reference is `pages/series-listing.png`, and the
 * layout is taken from it: a page title, one sentence under it, then rounded rows with a chevron.
 * What is dropped is its artwork thumbnail — artwork is deferred
 * ([epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md)) — and the row carries the date
 * recorded in its place, which is the thing that actually orders this list.
 *
 * **The order is the query's, never re-sorted here.** `GET /api/v1/recordings` orders by
 * `recorded_at`, and a second ordering in the client would be a second answer to "what is most
 * recent" ([3.3.1](docs/project/prd.md)).
 *
 * **This is the member surface, whatever the caller's role.** The list route answers an admin with
 * unpublished rows and object keys; this screen is not that route's console reading, and an admin
 * browsing here sees exactly what a member sees. What makes that true is one boolean on the read,
 * not anything on this screen.
 *
 * No search box, no filter and no pagination: [§3.10](docs/project/prd.md) is deferred and there
 * are five recordings. No per-recording progress column — [3.3.4](docs/project/prd.md) arrives with
 * Story 6.
 */

/** One fixed rendering of a date, matching the console's, so the product reads one way. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

export function Library() {
  const [recordings, setRecordings] = useState<readonly RecordingView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<RecordingListPayload>(MEMBER_RECORDINGS_PATH, { credentials: 'include' })
      .then((payload) => {
        setRecordings(payload.recordings);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        setRecordings(null);
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
        <h1 className={styles.pageTitle}>Recordings</h1>
        <p className={styles.pageLead}>Every teaching, most recently recorded first.</p>
      </header>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {recordings === null && failure === null ? (
        <p className={styles.quiet}>Loading recordings…</p>
      ) : null}

      {recordings !== null && recordings.length === 0 ? (
        <p className={styles.quiet}>Nothing has been published yet.</p>
      ) : null}

      {recordings !== null && recordings.length > 0 ? (
        <ul className={styles.rows} aria-label="Recordings">
          {recordings.map((recording) => (
            <li key={recording.id}>
              <Link className={styles.row} href={recordingPagePath(recording.id)}>
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{recording.title}</span>
                  {recording.description === null ? null : (
                    <span className={styles.rowDescription}>{recording.description}</span>
                  )}
                  <span className={styles.rowMeta}>{formatDay(recording.recordedAt)}</span>
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
