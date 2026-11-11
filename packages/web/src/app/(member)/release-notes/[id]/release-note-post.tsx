'use client';

import { useEffect, useState } from 'react';
import {
  RELEASE_NOTES_PAGE_PATH,
  releaseNotePath,
  type ReleaseNotePayload,
  type ReleaseNoteView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../../player-context';
import screens from '../../screens.module.css';
import { ReleaseNoteBody } from '../release-note-body';
import { formatReleaseNoteDay } from '../release-notes-listing';
import styles from '../release-notes.module.css';

/**
 * **One release note** — its title, the day it was published, and its body.
 *
 * The breadcrumb leads back to the list, so a member who arrived from a notification can find the
 * other posts. A post that does not exist — deleted since the link was made — says so in the
 * API's own words rather than rendering an empty page.
 */

const TRAIL = [{ label: 'Release notes', href: RELEASE_NOTES_PAGE_PATH }] as const;

export function ReleaseNotePost({ releaseNoteId }: { releaseNoteId: string }) {
  const [post, setPost] = useState<ReleaseNoteView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useBreadcrumbTrail(post?.title ?? null, TRAIL);

  useEffect(() => {
    let current = true;
    setPost(null);
    setFailure(null);
    void apiFetch<ReleaseNotePayload>(releaseNotePath(releaseNoteId), { credentials: 'include' })
      .then((payload) => {
        if (current) setPost(payload.releaseNote);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        setFailure(
          caught instanceof ApiClientError
            ? caught.message
            : 'Could not reach the server. Check your connection and try again.',
        );
      });
    return () => {
      current = false;
    };
  }, [releaseNoteId]);

  if (failure !== null) return <p className={screens.failure}>{failure}</p>;
  if (post === null) return <p className={screens.quiet}>Loading…</p>;

  return (
    <>
      <header className={screens.pageHead}>
        <h1 className={screens.pageTitle}>{post.title}</h1>
        <p className={styles.postMeta}>{formatReleaseNoteDay(post.publishedAt)}</p>
      </header>
      <article className={styles.post}>
        <ReleaseNoteBody doc={post.body} />
      </article>
    </>
  );
}
