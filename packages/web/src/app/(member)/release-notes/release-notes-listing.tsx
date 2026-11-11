'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  RELEASE_NOTES_PATH,
  releaseNotePagePath,
  type ReleaseNoteListPayload,
  type ReleaseNoteSummary,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../player-context';
import screens from '../screens.module.css';
import styles from './release-notes.module.css';

/**
 * **The release notes list.** One row per post, newest first, in the order the API answered and
 * never re-sorted here: the title, the first of its words, and the day it was published. A row is
 * a link to the post's own page.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function formatReleaseNoteDay(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

export function ReleaseNotesListing() {
  useBreadcrumbTrail('Release notes');
  const [posts, setPosts] = useState<readonly ReleaseNoteSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void apiFetch<ReleaseNoteListPayload>(RELEASE_NOTES_PATH, { credentials: 'include' })
      .then((payload) => {
        setPosts(payload.releaseNotes);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        setPosts(null);
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.',
        );
      });
  }, []);

  return (
    <>
      <header className={screens.pageHead}>
        <h1 className={screens.pageTitle}>Release notes</h1>
        <p className={screens.pageLead}>What is new in the app.</p>
      </header>

      {failure === null ? null : <p className={screens.failure}>{failure}</p>}

      {posts === null && failure === null ? (
        <p className={screens.quiet}>Loading release notes…</p>
      ) : null}

      {posts !== null && posts.length === 0 ? (
        <p className={screens.quiet}>Nothing has been posted yet.</p>
      ) : null}

      {posts !== null && posts.length > 0 ? (
        <ul className={screens.rows} aria-label="Release notes">
          {posts.map((one) => (
            <li key={one.id} className={screens.rowGroup}>
              <Link className={screens.row} href={releaseNotePagePath(one.id)}>
                <span className={screens.rowText}>
                  <span className={screens.rowTitle}>{one.title}</span>
                  {one.excerpt === '' ? null : <span className={styles.excerpt}>{one.excerpt}</span>}
                  <span className={screens.rowMeta}>{formatReleaseNoteDay(one.publishedAt)}</span>
                </span>
                <span className={screens.rowChevron} aria-hidden="true">
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
