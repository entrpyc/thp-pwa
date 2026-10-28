'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  formatTimecode,
  memberRecordingPath,
  recordingCrossReferencesPath,
  recordingPagePath,
  type CrossReferenceGroupView,
  type RecordingCrossReferencesPayload,
  type RecordingPayload,
  type RelatedSegmentView,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { usePlayer } from '../../player-context';
import { toLoaded, useRecordingContent } from './recording-content';
import { isPlainPress } from './round-trip';
import styles from './related.module.css';

/**
 * **The teaching's related moments, fetched once per teaching** — what the recording page and the
 * chapter page draw their `Related` tab off.
 *
 * Fetched by the page rather than by the panel, because the strip has to know whether there is
 * anything behind the tab before the tab is pressed — the same reason `hasScripture` rides on the
 * recording payload. The payload already carries the chapter each group falls in, so the chapter
 * page narrows the list with a filter rather than a second request.
 *
 * `null` until the answer lands, and `null` for good when the fetch failed: a member who was not
 * offered a related moment has lost an aside, not the teaching, so the failure state is silence.
 */
export function useRelatedGroups(recordingId: string): readonly CrossReferenceGroupView[] | null {
  const [groups, setGroups] = useState<readonly CrossReferenceGroupView[] | null>(null);

  useEffect(() => {
    let live = true;
    setGroups(null);
    void apiFetch<RecordingCrossReferencesPayload>(recordingCrossReferencesPath(recordingId), {
      credentials: 'include',
    })
      .then((payload) => {
        if (live) setGroups(payload.groups);
      })
      .catch(() => {
        if (live) setGroups(null);
      });
    return () => {
      live = false;
    };
  }, [recordingId]);

  return groups;
}

/**
 * **The groups of one chapter** — those whose triggering sentence the API bucketed into it, by
 * the same `chapterIdAt` the cap was applied with. What the chapter page's `Related` tab draws,
 * and what decides whether that tab is drawn at all.
 */
export function relatedGroupsInChapter(
  groups: readonly CrossReferenceGroupView[],
  chapterId: string,
): CrossReferenceGroupView[] {
  return groups.filter((group) => group.chapterId === chapterId);
}

/**
 * **Related moments in other teachings, each anchored to the moment of this one that triggered
 * it** ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)) — the `Related` tab of the
 * recording page and of the chapter page.
 *
 * Everything it needs it reads from what the page already provides — the groups the page fetched
 * ({@link useRelatedGroups}), the content source for seeking *this* teaching, and the player for
 * opening another one. Four decisions:
 *
 * - **The whole list, in spoken order.** The recording page shows every related moment the
 *   teaching has, not the ones near the playhead: a member reading the tab is surveying what else
 *   the teaching touches, and a list that emptied and refilled as the audio moved hid most of it
 *   most of the time. The chapter page narrows the same list to the chapter's own groups
 *   (`chapterId`), which is the page's scope for every other tab too.
 * - **Each group says where in this teaching it is anchored**, as a timecode and the sentence
 *   spoken there, and the timecode is a press: it seeks this teaching to the moment, without
 *   sound, through the same `seekToMs` the transcript's lines use — a member who wants to hear
 *   what triggered the link is one press from it.
 * - **Opening another teaching goes to the moment, without sound, and without stopping sound**
 *   ([3.2.12](docs/project/prd.md); the operator's call for this surface). The other teaching is
 *   handed to the player through `openIfIdle` — loaded *at* the moment, paused, when the transport
 *   is idle; left alone when a different teaching is audibly playing — and then the page navigates.
 *   The hand-over is awaited before the navigation, because the destination page opens its own
 *   teaching on mount and re-opening what is already loaded is a no-op: the order is what makes
 *   the position the link's rather than the stored one. A member who was hearing something else
 *   keeps hearing it and lands at their stored position, which is the quieter of the two wrongs.
 * - **The card is a real link.** A modified press — new tab, middle button — is left to the
 *   browser, which opens the page at the stored position; only a plain press takes the route above.
 */
export function RelatedTeachings({
  groups,
  chapterId,
}: {
  /** Every related group of this teaching, as {@link useRelatedGroups} answered it. */
  groups: readonly CrossReferenceGroupView[];
  /** On the chapter page, the chapter whose groups alone are shown. */
  chapterId?: string;
}) {
  const content = useRecordingContent();
  const player = usePlayer();
  const router = useRouter();

  const shown = useMemo(
    () => (chapterId === undefined ? groups : relatedGroupsInChapter(groups, chapterId)),
    [chapterId, groups],
  );

  const { openIfIdle } = player;

  async function openAt(link: RelatedSegmentView): Promise<void> {
    try {
      const payload = await apiFetch<RecordingPayload>(memberRecordingPath(link.recordingId), {
        credentials: 'include',
      });
      openIfIdle(toLoaded(payload.recording), link.startMs);
    } catch {
      // The page is still the right place to go; it opens at the stored position on its own.
    }
    router.push(recordingPagePath(link.recordingId));
  }

  function press(event: MouseEvent<HTMLAnchorElement>, link: RelatedSegmentView): void {
    if (!isPlainPress(event)) return;
    event.preventDefault();
    void openAt(link);
  }

  return (
    <section className={styles.panel} aria-label="Related teachings">
      <p className={styles.heading}>
        {chapterId === undefined ? 'Related in other teachings' : 'Related to this chapter'}
      </p>
      {shown.length === 0 ? (
        <p className={styles.quiet}>
          {chapterId === undefined
            ? 'Nothing in another teaching is related to this one.'
            : 'Nothing in another teaching is related to this chapter.'}
        </p>
      ) : (
        <ol className={styles.groups}>
          {shown.map((group) => (
            <li key={group.segmentId} className={styles.group}>
              {/*
                The moment of *this* teaching the links hang off: a press seeks there, without
                sound. The sentence beside it says what was said at that moment.
              */}
              <button
                className={styles.anchor}
                type="button"
                aria-label={`Go to ${formatTimecode(group.startMs)}`}
                onClick={() => content.seekToMs(group.startMs)}
              >
                <span className={styles.anchorTime}>{formatTimecode(group.startMs)}</span>
                <span className={styles.anchorText}>“{group.text}”</span>
              </button>
              <ul className={styles.list}>
                {group.links.map((link) => (
                  <li key={link.segmentId}>
                    <a
                      className={styles.card}
                      href={recordingPagePath(link.recordingId)}
                      onClick={(event) => press(event, link)}
                    >
                      <span className={styles.title}>{link.title}</span>
                      <span className={styles.meta}>
                        {link.series === null ? '' : `${link.series.title} · `}
                        at {formatTimecode(link.startMs)}
                      </span>
                      <span className={styles.excerpt}>“{link.text}”</span>
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
