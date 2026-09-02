'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
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
import { RecordingContentProvider, toLoaded, useRecordingContentFor } from './recording-content';
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
 *   description render directly in the page body, above the strip — description first, then
 *   summary, which is what a member reads in: the chosen line about the teaching, then what was
 *   said in it. The strip is **single-select**,
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
  /**
   * The stored position, kept for the play control. Usually `openIfIdle` has already handed it to
   * the player on mount — but when another teaching was playing then, the hand-over happens at the
   * play press instead, and the position has to still be in hand at that moment.
   */
  const [startAtMs, setStartAtMs] = useState<number | null>(null);
  /*
   * **Notes is open when the page is.** Every other tab is a download a member asks for, but the
   * notes are already in hand — the player fetches them on open, because the transport's markers
   * draw from them without any tab being pressed — so opening the panel costs nothing and is what
   * a member came to the page for. Pressing it still closes it.
   */
  const [openTab, setOpenTab] = useState<OpenTab>('notes');

  /**
   * **The panel area holds its height while a tab is swapped**, so the page cannot jump under the
   * member who pressed the tab.
   *
   * Without this, a press is three layouts rather than one: the open panel unmounts, the document
   * loses its height, and a member scrolled past what is left is **clamped** to the new bottom —
   * the page visibly slides down. The new panel then fetches, its content arrives, the document
   * grows again and the browser's scroll anchoring puts the position back. Measured on the
   * scripture tab, that round trip is about fifty milliseconds and a hundred and twenty pixels: too
   * fast to follow and far too big to miss.
   *
   * So the region keeps the height it had until giving it up would move nothing. What is held is a
   * `min-height` on the panels' own wrapper rather than the scroll position, because a scroll
   * position cannot be restored to somewhere the document no longer reaches — by the time the
   * clamp has happened, the room to put it back is gone.
   */
  const panelRegion = useRef<HTMLDivElement | null>(null);
  const [floorPx, setFloorPx] = useState(0);

  /**
   * Read the panel area's height **before** the swap, which is the only moment it can be read: one
   * render later the outgoing panel is gone and its height with it.
   */
  const chooseTab = (next: OpenTab) => {
    setFloorPx(panelRegion.current?.getBoundingClientRect().height ?? 0);
    setOpenTab((open) => (open === next ? null : next));
  };

  /**
   * Let the held height go the moment letting it go moves nothing.
   *
   * "Nothing" is a measurement, not a delay: the region shrinks by whatever the floor is holding
   * beyond the panel's own content, and that is safe exactly when the document is still tall enough
   * to reach the bottom of the window afterwards. A panel that arrives taller than the floor
   * releases on its first paint; a genuinely shorter one waits — for its own content, or for the
   * member to scroll up far enough that the space is no longer holding the page open — which is
   * what the observer and the two listeners are for. Until then the page carries some empty space
   * below the panel, which is invisible where it sits and cannot move anything.
   */
  useEffect(() => {
    if (floorPx === 0) return;
    const region = panelRegion.current;
    if (region === null) return;

    const release = () => {
      const panel = region.firstElementChild;
      const natural = panel === null ? 0 : panel.getBoundingClientRect().height;
      const shrinkBy = Math.max(0, floorPx - natural);
      const room = document.documentElement.scrollHeight - shrinkBy;
      if (shrinkBy === 0 || room >= window.scrollY + window.innerHeight) setFloorPx(0);
    };

    release();
    /*
     * **The observer watches the panel, not the region.** The region's height is exactly what the
     * floor is pinning, so it has no news to give — it is the panel inside it that grows when its
     * fetch lands, and that growth is usually what makes the floor safe to drop.
     */
    const observer = new ResizeObserver(release);
    const panel = region.firstElementChild;
    if (panel === null) observer.observe(region);
    else observer.observe(panel);
    window.addEventListener('scroll', release, { passive: true });
    window.addEventListener('resize', release);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', release);
      window.removeEventListener('resize', release);
    };
  }, [floorPx, openTab]);

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

  const { openIfIdle } = player;
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
      setStartAtMs(progress.positionMs);
      setFailure(null);
      // `openIfIdle`, not `open`: arriving on the page loads the teaching into the transport only
      // when doing so silences nothing. A member listening to something else keeps hearing it, and
      // this teaching takes the player over at the play control instead.
      openIfIdle(toLoaded(payload.recording), progress.positionMs);
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
  }, [openIfIdle, recordingId]);

  const isCurrent = player.loaded?.id === recordingId;

  /**
   * What the strip and its panels read: the player's notes and chapters while the player holds this
   * teaching, and the page's own fetch of them while a member is still hearing another one. See
   * `recording-content.tsx` — it is what lets the panels draw before the play control is pressed,
   * without ever showing another teaching's notes under this one's title.
   */
  const content = useRecordingContentFor(recordingId, recording, startAtMs);

  /**
   * The band holds the back control and is drawn before the teaching arrives, so the cover is read
   * defensively here rather than inside the branch that renders the loaded page.
   */
  const cover = recording?.series?.artworkUrl ?? null;

  /**
   * **The band keeps the cover's proportion while the page is still loading.** Most studies have a
   * cover, so the likeliest shape is the 3:1 band; drawing the coverless strip first and growing
   * it when the payload lands moved everything below it on nearly every open. A study that turns
   * out to have no cover settles to the strip once that is known — and so does a page that could
   * not be loaded, which has nothing to reserve room for.
   */
  const covered = cover !== null || (recording === null && failure === null);

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
      <div className={`${styles.hero}${covered ? ` ${styles.heroCovered}` : ''}`}>
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
              onClick={() =>
                isCurrent
                  ? player.toggle()
                  : // The transport holds a different teaching (it was playing when this page
                    // arrived, so the page left it alone). The press is the decision: this
                    // teaching takes the player over, at the stored position, playing.
                    player.openAndPlay(toLoaded(recording), startAtMs)
              }
            >
              <span aria-hidden="true">{isCurrent && player.playing ? '❚❚' : '▶'}</span>
            </button>
            <div className={styles.detailText}>
              <h1 className={styles.detailTitle}>{recording.title}</h1>
              <p className={styles.detailMeta}>Recorded {formatDay(recording.recordedAt)}</p>
            </div>
          </header>

          {/*
            **Description first, then summary.** The description is what an admin wrote *about* this
            teaching — a line or two, chosen, and the same text the library row carries — so it is
            the sentence a member arriving from that row is already half-reading. The summary is
            generated from what was actually said and is as long as the teaching was; it answers a
            question the description has just raised rather than the other way round.

            Both blocks clamp rather than run: between them they can push the tab strip off the
            screen. Clamped, they cost six lines each and the strip stays where a member left it.
          */}
          {recording.description === null ? null : (
            <CollapsibleProse label="Description" text={recording.description} />
          )}

          {recording.summary === null ? null : (
            <CollapsibleProse label="Summary" text={recording.summary} />
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
          {/*
            **The strip and its panels do not wait for this teaching to hold the player.** A member
            still hearing another teaching reads this one's notes and chapters all the same: the
            panels draw from `content`, which is the page's own fetch of *this* teaching while the
            player holds a different one, so nothing under this title can be another recording's.
            Nothing under the strip starts sound either — the play control above is what hands the
            player over, and until it is pressed the other teaching keeps playing.
          */}
          <RecordingContentProvider value={content}>
          <div className={styles.tabs} role="tablist" aria-label="Teaching contents">
            <button
              className={`${styles.tab} ${styles.notesTab}`}
              type="button"
              role="tab"
              aria-selected={openTab === 'notes'}
              onClick={() => chooseTab('notes')}
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
              the list the page already holds rather than off a flag on the recording payload,
              because that list is fetched when the teaching is opened regardless (3.22.16) and a
              second answer to "does this teaching have chapters" could disagree with the first.
            */}
            {(content.chapters?.length ?? 0) > 0 ? (
              <button
                className={styles.tab}
                type="button"
                role="tab"
                aria-selected={openTab === 'chapters'}
                onClick={() => chooseTab('chapters')}
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
                onClick={() => chooseTab('scripture')}
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
                onClick={() => chooseTab('transcript')}
              >
                Transcript
              </button>
            */}
          </div>

          {/*
            **One wrapper around whichever panel is open**, and the thing whose height is held
            across a swap — see `floorPx` above. It is drawn while a tab is open and while a floor
            is still being held for a tab that has just closed, and not at all otherwise: an empty
            element left in the column would spend a gap on nothing.
          */}
          {openTab === null && floorPx === 0 ? null : (
            <div
              ref={panelRegion}
              style={floorPx === 0 ? undefined : { minHeight: `${floorPx}px` }}
            >
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
            </div>
          )}
          </RecordingContentProvider>
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
