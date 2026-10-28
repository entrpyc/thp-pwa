'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  FLOW_TRACKER_PAGE_PATH,
  HIGHLIGHTS_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  MY_NOTES_PAGE_PATH,
  RESUME_PATH,
  formatTimecode,
  recordingPagePath,
  type ResumePayload,
  type ResumeView,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { FlowIcon } from './flow-tracker/flow-icon';
import { MarkerIcon } from './highlights/marker-icon';
import { NotesIcon } from './notes/notes-icon';
import { usePlayer } from './player-context';
import { SosCard } from './prayer-requests/sos-card';
import { SeriesIcon } from './series-icon';
import styles from './screens.module.css';

/**
 * **The member landing** — `pages/dashboard.png`.
 *
 * The reference has three cards. The screen is three rows, in the order the operator set:
 *
 * - **Resume recording** — first. Story 4's, and the marquee behaviour behind it.
 * - **The tiles** — two rows of two, each a big icon over one word, in the order the operator
 *   set: **Notes** and **Highlights** on the first row, **Series** and **Flow Tracker** on the
 *   second. Their accessible names say the destination in full — *View my notes*, *View
 *   highlights*, *View all series*, *View Flow Tracker* — which is what the word on each tile
 *   abbreviates and what every test calls them. Story 4 shipped the series way-in pointing at the
 *   library, because series did not exist yet; Story 6 gave it the destination the reference
 *   draws. *All recordings* did not disappear with it — it is an entry in the menu, beside *All
 *   series*. Highlights goes to the member's own playlist ([3.15.5](docs/project/prd.md)); its icon
 *   is the highlighter every highlight control draws, so the tile is recognised rather than read.
 *   Notes goes to the member's own notes across every teaching, and Flow Tracker to
 *   [3.14](docs/project/prd.md)'s page — both reached from here and no longer from the menu, by
 *   the operator's decision: the menu keeps the destinations the tiles do not draw.
 * - **SOS** — the last row. Not in the reference, and added by the operator's decision when
 *   [§3.16](docs/project/prd.md) shipped: the prayer emergency channel's way in is a card here
 *   rather than a navigation entry, with the open counts, the most urgent signals and Raise SOS.
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
          seriesId: playing.seriesId,
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
        <section className={`${styles.card} ${styles.resumeCard}`} aria-label="Resume recording">
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

      {/* Two columns, so four tiles are two rows: Notes and Highlights, then Series and Flow Tracker. */}
      <div className={styles.tiles}>
        <Link className={styles.tile} href={MY_NOTES_PAGE_PATH} aria-label="View my notes">
          <span className={styles.tileIcon}>
            <NotesIcon size={40} />
          </span>
          <span className={styles.tileLabel}>Notes</span>
        </Link>
        <Link className={styles.tile} href={HIGHLIGHTS_PAGE_PATH} aria-label="View highlights">
          <span className={styles.tileIcon}>
            <MarkerIcon marked={false} size={40} />
          </span>
          <span className={styles.tileLabel}>Highlights</span>
        </Link>
        <Link className={styles.tile} href={MEMBER_SERIES_PAGE_PATH} aria-label="View all series">
          <span className={styles.tileIcon}>
            <SeriesIcon size={40} />
          </span>
          <span className={styles.tileLabel}>Series</span>
        </Link>
        <Link className={styles.tile} href={FLOW_TRACKER_PAGE_PATH} aria-label="View Flow Tracker">
          <span className={styles.tileIcon}>
            <FlowIcon size={40} />
          </span>
          <span className={styles.tileLabel}>Flow Tracker</span>
        </Link>
      </div>

      <SosCard />
    </>
  );
}
