'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_LIBRARY_PAGE_PATH,
  memberRecordingPath,
  recordingProgressPath,
  seriesPagePath,
  type PlaybackProgressPayload,
  type RecordingPayload,
  type RecordingView as Recording,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer } from '../../player-context';
import { NotesPanel } from './notes-panel';
import { TranscriptPanel } from './transcript-panel';
import styles from '../../screens.module.css';

/** The strip is single-select: opening one tab closes the other, and `null` is both closed. */
type OpenTab = 'notes' | 'transcript' | null;

/**
 * **The recording page** — `pages/recording.png`.
 *
 * The reference, read against what this epic has:
 *
 * - **The hero artwork becomes a flat `--color-bg-deep` band** carrying the back control. Artwork is
 *   deferred, and the band keeps the slot so a picture drops into it later without moving anything.
 * - **A tab strip holding two tabs.** The reference draws five — `Chapter`, `Scripture`, `Notes`,
 *   `Transcript`, `Mindmap` — and only those two have data. The other three are dropped rather than
 *   rendered disabled, which is the line the whole member surface draws for a deferred destination.
 *   Summary and description render directly in the page body, above the strip. The strip is
 *   **single-select**, the way the reference reads it: opening `Notes` closes `Transcript`.
 * - **The tabs start closed.** A member who never opens it downloads no transcript; pressing it is
 *   what asks for one, and pressing it again puts it away. The notes are the exception and are
 *   fetched when the teaching is opened, because their markers show on the transport without the
 *   tab (active-scope prd 3.2.4).
 * - **No chapter list, no chapter search, no download control.** All deferred; all dropped rather
 *   than disabled.
 *
 * **Opening the page loads the teaching and does not play it.** The stored position is restored
 * once the element has metadata — seeking before that is silently clamped to zero — and the member
 * presses play when they want sound.
 *
 * The back control returns to the library rather than to browser history, so it behaves the same
 * when the page was opened from a link rather than navigated to.
 */
export function RecordingScreen({
  recordingId,
  canCorrect,
}: {
  recordingId: string;
  /** Whether to render the correction affordance. It grants nothing — the API refuses a member. */
  canCorrect: boolean;
}) {
  const player = usePlayer();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<OpenTab>(null);

  /**
   * `home › series › recording` when this teaching is in one, and today's two segments when it is
   * not (Story 6). The series comes off the recording payload rather than off the navigation that
   * reached the page, so opening a teaching from a link draws the same trail as walking to it.
   */
  useBreadcrumbTrail(
    recording?.title ?? null,
    recording?.series?.title ?? null,
    recording?.series === undefined || recording.series === null
      ? null
      : seriesPagePath(recording.series.id),
  );

  const { open } = player;
  useEffect(() => {
    let live = true;

    async function load(): Promise<void> {
      // The recording and the position together: the player needs both before it can point the
      // element anywhere, and asking for them in sequence would seek twice.
      const [payload, progress] = await Promise.all([
        apiFetch<RecordingPayload>(memberRecordingPath(recordingId), { credentials: 'include' }),
        apiFetch<PlaybackProgressPayload>(recordingProgressPath(recordingId), {
          credentials: 'include',
        }),
      ]);
      if (!live) return;
      setRecording(payload.recording);
      setFailure(null);
      open({ id: payload.recording.id, title: payload.recording.title }, progress.positionMs);
    }

    void load().catch((caught: unknown) => {
      if (!live) return;
      setRecording(null);
      setFailure(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    });

    return () => {
      live = false;
    };
  }, [open, recordingId]);

  const isCurrent = player.loaded?.id === recordingId;

  return (
    <>
      <div className={styles.hero}>
        <Link className={styles.back} href={MEMBER_LIBRARY_PAGE_PATH} aria-label="Back to recordings">
          <span aria-hidden="true">‹</span>
        </Link>
      </div>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {recording === null ? (
        failure === null ? (
          <p className={styles.quiet}>Loading the teaching…</p>
        ) : null
      ) : (
        <>
          <header className={styles.detailHead}>
            {/*
              The one filled circle on this screen, exactly where the reference puts it. It is the
              same player the docked bar drives — pressing either is pressing the same element.
            */}
            <button
              className={styles.detailPlay}
              type="button"
              aria-label={isCurrent && player.playing ? 'Pause' : 'Play'}
              onClick={() => player.toggle()}
            >
              <span aria-hidden="true">{isCurrent && player.playing ? '❚❚' : '▶'}</span>
            </button>
            <div className={styles.detailText}>
              <h1 className={styles.detailTitle}>{recording.title}</h1>
              <p className={styles.detailMeta}>Recorded {formatDay(recording.recordedAt)}</p>
            </div>
          </header>

          {recording.summary === null ? null : (
            <section className={styles.card} aria-label="Summary">
              <h2 className={styles.cardTitle}>Summary</h2>
              <p className={styles.prose}>{recording.summary}</p>
            </section>
          )}

          {recording.description === null ? null : (
            <section className={styles.card} aria-label="Description">
              <h2 className={styles.cardTitle}>Description</h2>
              <p className={styles.prose}>{recording.description}</p>
            </section>
          )}

          {/*
            `pages/recording.png`'s strip, same pill shape and same spacing, in the reference's own
            order — `Notes` before `Transcript`. When `Scripture`, `Chapter` and `Mindmap` arrive
            they are entries here, not a different control.

            `Notes` is the one place in the product entitled to the green (style-guide principle 5),
            so its icon and its selected state take `--color-notes` where `Transcript` takes the
            purple every other selected thing takes.
          */}
          <div className={styles.tabs} role="tablist" aria-label="Teaching contents">
            <button
              className={`${styles.tab} ${styles.notesTab}`}
              type="button"
              role="tab"
              aria-selected={openTab === 'notes'}
              onClick={() => setOpenTab((open) => (open === 'notes' ? null : 'notes'))}
            >
              <span className={styles.notesIcon} aria-hidden="true">
                ✎
              </span>
              Notes
            </button>
            <button
              className={styles.tab}
              type="button"
              role="tab"
              aria-selected={openTab === 'transcript'}
              onClick={() => setOpenTab((open) => (open === 'transcript' ? null : 'transcript'))}
            >
              Transcript
            </button>
          </div>

          {openTab === 'notes' ? <NotesPanel recordingId={recordingId} /> : null}

          {openTab === 'transcript' ? (
            <TranscriptPanel recordingId={recordingId} canCorrect={canCorrect} />
          ) : null}
        </>
      )}
    </>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}
