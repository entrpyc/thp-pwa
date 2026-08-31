'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_SERIES_PAGE_PATH,
  RESUME_PATH,
  formatTimecode,
  recordingPagePath,
  type ResumePayload,
  type ResumeView,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { usePlayer } from './player-context';
import styles from './screens.module.css';

/**
 * **The member landing** — `pages/dashboard.png`.
 *
 * The reference has three cards. One ships:
 *
 * - **Resume recording** — Story 4's, and the marquee behaviour behind it.
 * - **View all series**. Story 4 shipped this row pointing at the library, because series did not
 *   exist yet; Story 6 gives it the destination the reference draws. *All recordings* did not
 *   disappear with it — it is an entry in the menu, beside *All series*, which is where
 *   `top-navigation/menu-opened.png` puts both.
 * - **My notes** — [§3.12](docs/project/prd.md) is deferred whole, so the card is **dropped**
 *   rather than rendered empty. An empty card is a promise; a missing one is a screen that will
 *   grow.
 *
 * **Elapsed only.** The reference prints `01:23 / 02:30`, and the second half of that is a number
 * this epic has nowhere: nothing inspects the media and `recording` has no duration column. So the
 * card says where the member got to, and the player learns the total from the element.
 *
 * Pressing the card goes to the teaching. It deliberately does **not** start playing from here — a
 * member who tapped a card on a phone in company has not asked for sound, and the recording page
 * restores the same position anyway.
 */
export function Landing() {
  const player = usePlayer();
  const [resume, setResume] = useState<ResumeView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void apiFetch<ResumePayload>(RESUME_PATH, { credentials: 'include' })
      .then((payload) => setResume(payload.resume))
      .catch(() => setResume(null))
      .finally(() => setLoaded(true));
  }, []);

  /*
   * **What is in the player wins.** The stored row is what this member was last listening to *as of
   * the last write*, and writes are on a cadence — so a member who plays a teaching and comes back
   * here would be offered the one before it until the next tick, which is the card naming the wrong
   * teaching at exactly the moment they can see it is wrong.
   *
   * The player is the authority on what is being played, so the card reads it and falls back to the
   * row. The two agree on a cold load, because the provider is what opened the row into the player.
   * The description only survives the swap when they are the same teaching: it belongs to the row,
   * and the transport does not carry one.
   */
  const playing = player.loaded;
  const card: ResumeView | null =
    playing === null
      ? resume
      : {
          recordingId: playing.id,
          title: playing.title,
          description: resume?.recordingId === playing.id ? resume.description : null,
          positionMs: player.currentMs,
          seriesTitle: playing.seriesTitle,
          artworkUrl: playing.artworkUrl,
        };

  return (
    <>
      {/*
        The reference carries no page title — the breadcrumb bar is the heading a member reads. A
        screen still needs one h1, so it is here and it is not painted.
      */}
      <h1 className={styles.hiddenTitle}>Dashboard</h1>

      {/*
        `loaded` is only the gate on the *fetched* row — it is what stops a card appearing and then
        being replaced a moment later. A teaching already in the player needs no such wait: it is
        there before this screen mounts.
      */}
      {card !== null && (loaded || playing !== null) ? (
        <section className={styles.card} aria-label="Resume recording">
          <h2 className={styles.cardTitle}>Resume recording</h2>
          <Link className={styles.resume} href={recordingPagePath(card.recordingId)}>
            <span className={styles.resumePlay} aria-hidden="true">
              ▶
            </span>
            <span className={styles.resumeText}>
              <span className={styles.resumeName}>{card.title}</span>
              {card.description === null ? null : (
                <span className={styles.resumeDescription}>{card.description}</span>
              )}
              <span className={styles.resumeAt}>
                Resume at {formatTimecode(card.positionMs)}
              </span>
            </span>
          </Link>
        </section>
      ) : null}

      <Link className={styles.wayIn} href={MEMBER_SERIES_PAGE_PATH}>
        <span className={styles.wayInLabel}>View all series</span>
        <span className={styles.wayInArrow} aria-hidden="true">
          →
        </span>
      </Link>
    </>
  );
}
