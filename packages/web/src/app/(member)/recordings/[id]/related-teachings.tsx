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
 * **Related moments in other teachings, anchored to the part playing now**
 * ([3.9.2](docs/project/prd.md), [3.9.5](docs/project/prd.md)).
 *
 * Self-contained on purpose: the page imports it in one line and mounts it in one element, and
 * everything it needs it reads from what the page already provides — the content source for
 * *this* teaching's position and chapters, and the player for opening another one. Five decisions:
 *
 * - **Fetched once per teaching, filtered as the playhead moves.** The payload already carries
 *   the chapter each group falls in, so following the position is arithmetic over a list of a
 *   few dozen entries rather than a request every few seconds.
 * - **Anchored to the chapter.** The links shown are those whose triggering sentence falls in the
 *   chapter that contains the position, by the same `chapterIdAt` the API bucketed them with — so
 *   the three the API chose for a chapter are the three shown for it, and a teaching with no
 *   chapters shows its three throughout. Sentences are a few seconds long; a strip that changed
 *   with each one would flicker, and the chapter is the unit a member is listening to.
 * - **Quiet.** Nothing is drawn — no heading, no empty state, no space — while the part playing has
 *   no links, while the chapters are not known yet, or when the fetch failed. The teaching is the
 *   point of the page; this is an aside that appears when it has something to say.
 * - **Opening goes to the moment, without sound, and without stopping sound**
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
export function RelatedTeachings({ recordingId }: { recordingId: string }) {
  const content = useRecordingContent();
  const player = usePlayer();
  const router = useRouter();
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
        // A failure stays inside the strip, and the strip's failure state is silence: a member
        // who was not offered a related moment has lost an aside, not the teaching.
        if (live) setGroups(null);
      });
    return () => {
      live = false;
    };
  }, [recordingId]);

  // `undefined` while the chapters are not known yet, which draws nothing; `null` is a teaching
  // with no chapters, which is one bucket.
  const chapters = content.chapters;
  const currentChapterId =
    chapters === null ? undefined : chapterIdAt(chapters, content.positionMs);

  const shown = useMemo(
    () =>
      groups === null || currentChapterId === undefined
        ? []
        : groups.filter((group) => group.chapterId === currentChapterId),
    [currentChapterId, groups],
  );

  if (shown.length === 0) return null;

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
      <p className={styles.heading}>Related to this part</p>
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
    </section>
  );
}
