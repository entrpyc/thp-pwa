'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  chapterIdAt,
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
 * **The teaching's related moments, fetched once per teaching** — what the recording page draws
 * its `Related` tab off, and what the panel behind that tab narrows to the part playing.
 *
 * Fetched by the page rather than by the panel, because the strip has to know whether there is
 * anything behind the tab before the tab is pressed — the same reason `hasScripture` rides on the
 * recording payload. The payload already carries the chapter each group falls in, so following the
 * position afterwards is arithmetic over a list of a few dozen entries rather than a request.
 *
 * `null` until the answer lands, and `null` for good when the fetch failed: a member who was not
 * offered a related moment has lost an aside, not the teaching, so the failure state is silence.
 * `null` too for no teaching at all — the now-playing view asks before anything has been opened.
 */
export function useRelatedGroups(
  recordingId: string | null,
): readonly CrossReferenceGroupView[] | null {
  const [groups, setGroups] = useState<readonly CrossReferenceGroupView[] | null>(null);

  useEffect(() => {
    let live = true;
    setGroups(null);
    if (recordingId === null) return;
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
 * **The press that opens a related moment** — shared by the recording page's `Related` tab and the
 * now-playing view's row, so the two cannot disagree about what pressing a related moment does.
 *
 * The other teaching is handed to the player through `openIfIdle` — loaded *at* the moment,
 * paused, when the transport is idle; left alone when a different teaching is audibly playing —
 * and then the page navigates ([3.9.5](docs/project/prd.md), [3.2.12](docs/project/prd.md)). The
 * hand-over is awaited before the navigation, because the destination page opens its own teaching
 * on mount and re-opening what is already loaded is a no-op: the order is what makes the position
 * the link's rather than the stored one. A modified press — new tab, middle button — is left to the
 * browser, which opens the page at the stored position; only a plain press takes the route above.
 */
export function useOpenRelated(): (
  event: MouseEvent<HTMLAnchorElement>,
  link: RelatedSegmentView,
) => void {
  const { openIfIdle } = usePlayer();
  const router = useRouter();

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

  return (event, link) => {
    if (!isPlainPress(event)) return;
    event.preventDefault();
    void openAt(link);
  };
}

/**
 * **Related moments in other teachings, anchored to the part playing now**
 * ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)) — the `Related` tab of the
 * recording page.
 *
 * Everything it needs it reads from what the page already provides — the groups the page fetched
 * ({@link useRelatedGroups}), the content source for *this* teaching's position and chapters, and
 * the player for opening another one. Four decisions:
 *
 * - **Anchored to the chapter.** The links shown are those whose triggering sentence falls in the
 *   chapter that contains the position, by the same `chapterIdAt` the API bucketed them with — so
 *   the three the API chose for a chapter are the three shown for it, and a teaching with no
 *   chapters shows its three throughout. Sentences are a few seconds long; a list that changed
 *   with each one would flicker, and the chapter is the unit a member is listening to.
 * - **The empty part is stated.** The tab is drawn only for a teaching with a related moment
 *   somewhere in it, so a part with none is a fact about *this* part, and the panel says so rather
 *   than drawing an empty list — which is what the tab being open at all has asked for.
 * - **Opening goes to the moment, without sound, and without stopping sound**
 *   ([3.2.12](docs/project/prd.md); the operator's call for this surface) — {@link useOpenRelated}.
 *   A member who was hearing something else keeps hearing it and lands at their stored position,
 *   which is the quieter of the two wrongs.
 * - **The card is a real link.** A modified press — new tab, middle button — is left to the
 *   browser, which opens the page at the stored position; only a plain press takes the route above.
 */
export function RelatedTeachings({
  recordingId,
  groups,
}: {
  recordingId: string;
  /** Every related group of this teaching, as {@link useRelatedGroups} answered it. */
  groups: readonly CrossReferenceGroupView[];
}) {
  const content = useRecordingContent();
  const press = useOpenRelated();

  // `undefined` while the chapters are not known yet; `null` is a teaching with no chapters, which
  // is one bucket.
  const chapters = content.chapters;
  const currentChapterId =
    chapters === null ? undefined : chapterIdAt(chapters, content.positionMs);

  const shown = useMemo(
    () =>
      currentChapterId === undefined
        ? []
        : groups.filter((group) => group.chapterId === currentChapterId),
    [currentChapterId, groups],
  );

  return (
    <section className={styles.panel} aria-label="Related teachings">
      <p className={styles.heading}>Related to this part</p>
      {shown.length === 0 ? (
        <p className={styles.quiet}>
          {currentChapterId === undefined
            ? 'Finding the part playing…'
            : 'Nothing in another teaching is related to this part.'}
        </p>
      ) : (
        <ul className={styles.list}>
          {shown.flatMap((group) =>
            group.links.map((link) => (
              <li key={`${group.segmentId}:${link.segmentId}`}>
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
            )),
          )}
        </ul>
      )}
    </section>
  );
}
