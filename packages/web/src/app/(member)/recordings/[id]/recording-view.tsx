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
import { ChaptersPanel } from './chapters-panel';
import { CollapsibleProse } from './collapsible-prose';
import { NotesPanel } from './notes-panel';
import { ScripturePanel } from './scripture-panel';
import { TranscriptPanel } from './transcript-panel';
import styles from '../../screens.module.css';

/** The strip is single-select: opening one tab closes the others, and `null` is all closed. */
type OpenTab = 'chapters' | 'scripture' | 'notes' | 'transcript' | null;

/**
 * **The recording page** — `pages/recording.png`.
 *
 * The reference, read against what this epic has:
 *
 * - **The hero band is the cover of the series this teaching is in**, the column's width and 3:1 as
 *   `pages/chapter.png` draws it, with the back control over it (scope prd 3.2.3, 3.2.7). The
 *   cover is the *series'* — a recording has none of its own — so every teaching in one study
 *   shows the same picture, and a teaching in no series keeps the flat band (scope prd 3.2.6).
 * - **A tab strip holding three tabs.** The reference draws five — `Chapter`, `Scripture`, `Notes`,
 *   `Transcript`, `Mindmap` — and four of them have data: `Chapters` arrived with
 *   [3.22.10](docs/project/prd.md) and `Mindmap` is still dropped rather than rendered disabled,
 *   which is the line the whole member surface draws for a deferred destination. Summary and
 *   description render directly in the page body, above the strip. The strip is **single-select**,
 *   the way the reference reads it: opening `Notes` closes `Scripture`.
 * - **`Transcript` is hidden**, and it is the one entry missing for a reason that is not about
 *   data. `Mindmap` is absent because nothing was built; `Scripture` and `Chapters` come and go with
 *   what a teaching has. This one is a decision taken over a feature that works — so the control is
 *   commented in place at the strip rather than deleted, and everything behind it is untouched.
 * - **`Scripture` is drawn only for a teaching that has some** (active-scope prd 3.4.4) — the same
 *   line, one step further: a destination with no data behind it is left out rather than offered
 *   empty. The recording payload carries `hasScripture` so that decision costs no request.
 * - **`Notes` starts open; everything else starts closed.** A member who never presses a tab
 *   downloads nothing behind it — pressing it is what asks, and pressing it again puts it away.
 *   The notes are the exception at both ends: they are fetched when the *teaching* is opened,
 *   because their markers show on the transport without the tab (active-scope prd 3.2.4), so the
 *   panel is drawing something the page already holds and there is nothing to save by hiding it.
 * - **`Chapters` is drawn only for a teaching that has some** ([3.22.10](docs/project/prd.md)) —
 *   the same line 3.4.4 draws for `Scripture`, and the requirement says so outright: a recording
 *   with no chapters ([3.22.4](docs/project/prd.md)) does not show the tab at all. It costs no
 *   request either, but for a different reason: the chapters were fetched when the *teaching* was
 *   opened, because the transport names the chapter playing on every screen
 *   ([3.22.16](docs/project/prd.md)) — so, like the notes, the panel draws something the page
 *   already holds.
 * - **No download control.** Deferred; dropped rather than disabled.
 *
 * **Opening the page loads the teaching and does not play it.** The stored position is restored
 * once the element has metadata — seeking before that is silently clamped to zero — and the member
 * presses play when they want sound.
 *
 * **The back control returns to the series this teaching is in**, and to the library only for a
 * teaching that is in none. Never to browser history, so it behaves the same when the page was
 * opened from a link as when it was walked to — which is the whole reason it is a destination rather
 * than a `history.back()`: a member who arrived from a shared link has no history to go back to, and
 * the study is where the teaching actually lives.
 */
export function RecordingScreen({
  recordingId,
  canCorrect,
  canModerate,
  canEditChapters,
}: {
  recordingId: string;
  /** Whether to render the correction affordance. It grants nothing — the API refuses a member. */
  canCorrect: boolean;
  /** Whether to render the admin entries in a note's overflow. It grants nothing either. */
  canModerate: boolean;
  /** Whether to render the chapter edit, split and merge controls. It grants nothing either. */
  canEditChapters: boolean;
}) {
  const player = usePlayer();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /*
   * **Notes is open when the page is.** Every other tab is a download a member asks for, but the
   * notes are already in hand — the player fetches them on open, because the transport's markers
   * draw from them without any tab being pressed — so opening the panel costs nothing and is what
   * a member came to the page for. Pressing it still closes it.
   */
  const [openTab, setOpenTab] = useState<OpenTab>('notes');

  /**
   * `home › series › recording` when this teaching is in one, and today's two segments when it is
   * not (Story 6). The series comes off the recording payload rather than off the navigation that
   * reached the page, so opening a teaching from a link draws the same trail as walking to it.
   */
  useBreadcrumbTrail(
    recording?.title ?? null,
    recording?.series == null
      ? []
      : [{ label: recording.series.title, href: seriesPagePath(recording.series.id) }],
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
      open(
        {
          id: payload.recording.id,
          title: payload.recording.title,
          // The transport's tile is the series' cover, handed over with the teaching rather than
          // fetched by the bar — this is the one place that knows both (scope prd 3.2.4).
          artworkUrl: payload.recording.series?.artworkUrl ?? null,
          seriesTitle: payload.recording.series?.title ?? null,
        },
        progress.positionMs,
      );
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

  /**
   * A transport marker asking for a note **opens the tab it lives in** (active-scope prd 3.2.5).
   *
   * The panel does the scrolling and clears the request; this only has to make sure there is a
   * panel to scroll. Watching the request rather than being called by the transport is what lets
   * the marker work from any screen: on this one it opens the tab, and everywhere else it is a
   * request nothing is listening for, which is exactly right — there is no list there to open.
   */
  const revealed = player.revealedNoteId;
  useEffect(() => {
    if (revealed !== null) setOpenTab('notes');
  }, [revealed]);

  const isCurrent = player.loaded?.id === recordingId;

  /**
   * The band holds the back control and is drawn before the teaching arrives, so the cover is read
   * defensively here rather than inside the branch that renders the loaded page.
   */
  const cover = recording?.series?.artworkUrl ?? null;

  /**
   * **Back goes to the study this teaching is part of**, and to the library only for a teaching that
   * is in none.
   *
   * It is the same destination the breadcrumb's parent segment points at, read off the same field of
   * the same payload — so the two controls that mean "up from here" cannot disagree, which they
   * would the moment one of them derived its answer from the navigation that reached the page.
   *
   * A teaching in no series keeps the library, because there is no study page to return to; that is
   * the ordinary case rather than a degraded one, exactly as the missing cover above is. The same
   * fallback covers the moment before the payload lands, when the band is already drawn and there is
   * nothing yet to know — the breadcrumb draws its two segments in that window for the same reason.
   */
  const series = recording?.series ?? null;
  const back =
    series === null
      ? { href: MEMBER_LIBRARY_PAGE_PATH, label: 'Back to recordings' }
      : { href: seriesPagePath(series.id), label: `Back to ${series.title}` };

  return (
    <>
      <div className={`${styles.hero}${cover === null ? '' : ` ${styles.heroCovered}`}`}>
        {/*
          The cover of the *series* this teaching is in — a recording has none of its own (scope
          prd 3.2.3). A teaching in no series has no ref to read one from, which is 3.2.6's case
          here and is ordinary rather than degraded.
        */}
        {cover === null ? null : (
          <>
            <img className={styles.heroArt} src={cover} alt="" />
            <span className={styles.heroFade} aria-hidden="true" />
          </>
        )}
        <Link className={styles.back} href={back.href} aria-label={back.label}>
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

          {/*
            Both blocks open rather than run: a summary is as long as the teaching was and a
            description is as long as an admin typed, so between them they can push the tab strip
            off the screen on the way to a transcript. Clamped, they cost six lines each and the
            strip stays where a member left it.
          */}
          {recording.summary === null ? null : (
            <CollapsibleProse label="Summary" text={recording.summary} />
          )}

          {recording.description === null ? null : (
            <CollapsibleProse label="Description" text={recording.description} />
          )}

          {/*
            `pages/recording.png`'s strip, same pill shape and same spacing. The order is `Notes`,
            then `Chapters`, then `Scripture` — the reference draws `Scripture` first, but `Notes`
            is the tab a member returns to and the one entry that is always there, so it takes the
            first slot rather than moving whenever a teaching happens to cite nothing. When
            `Mindmap` arrives it is an entry here, not a different control.

            `Notes` is the one place in the product entitled to the green (style-guide principle 5),
            so its icon and its selected state take `--color-notes` where the others take the
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
            {/*
              Absent entirely rather than disabled for a teaching that cites nothing (3.4.4) — the
              same line the strip already draws for `Chapter` and `Mindmap`, decided off the payload
              the page already has rather than off a passage nobody asked for.
            */}
            {/*
              Absent entirely for a teaching with no chapters (3.22.10) — the same line, decided off
              the list the player already holds rather than off a flag on the recording payload,
              because that list is fetched when the teaching is opened regardless (3.22.16) and a
              second answer to "does this teaching have chapters" could disagree with the first.
            */}
            {(player.chapters?.chapters.length ?? 0) > 0 ? (
              <button
                className={styles.tab}
                type="button"
                role="tab"
                aria-selected={openTab === 'chapters'}
                onClick={() => setOpenTab((open) => (open === 'chapters' ? null : 'chapters'))}
              >
                Chapters
              </button>
            ) : null}
            {recording.hasScripture ? (
              <button
                className={styles.tab}
                type="button"
                role="tab"
                aria-selected={openTab === 'scripture'}
                onClick={() => setOpenTab((open) => (open === 'scripture' ? null : 'scripture'))}
              >
                Scripture
              </button>
            ) : null}
            {/*
              **`Transcript` is hidden**, by operator decision rather than by a rule about data —
              which is why it is commented here rather than dropped the way `Mindmap` is. Everything
              behind it is intact: the panel, the correction path, the route and the payload. What
              is gone is the one control that opened it, so `openTab` can no longer take the value
              and the panel below is unreachable until this button comes back.

              Bringing it back is this element and nothing else. `transcript-screen.test.ts` and
              `transcript-correction-screen.test.ts` are skipped while it is away, and un-skipping
              them is the other half of that change.

              <button
                className={styles.tab}
                type="button"
                role="tab"
                aria-selected={openTab === 'transcript'}
                onClick={() => setOpenTab((open) => (open === 'transcript' ? null : 'transcript'))}
              >
                Transcript
              </button>
            */}
          </div>

          {openTab === 'notes' ? (
            <NotesPanel recordingId={recordingId} canModerate={canModerate} />
          ) : null}

          {openTab === 'chapters' ? (
            <ChaptersPanel recordingId={recordingId} canEdit={canEditChapters} />
          ) : null}

          {openTab === 'scripture' ? <ScripturePanel recordingId={recordingId} /> : null}

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
