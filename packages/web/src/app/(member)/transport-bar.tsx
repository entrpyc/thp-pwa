'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  NOW_PLAYING_PAGE_PATH,
  PLAYBACK_SPEEDS,
  chapterPagePath,
  formatPlaybackSpeed,
  formatTimecode,
  type NoteView,
} from '@thp/shared';
import { segmentAt } from '@/client/transcript/current-segment';
import { NoteComposer } from './recordings/[id]/note-composer';
import { momentEntry } from './highlights/highlights-lookup';
import { useHighlights } from './highlights/highlights-store';
import { PinMomentTool } from './highlights/pin-moment-tool';
import { usePlayer } from './player-context';
import styles from './transport.module.css';

/**
 * **The transport** — `bottom-navigation/default.png`, docked to the bottom of every member screen.
 *
 * The reference, read as built: play/pause is the one **filled** purple circle, ±10s are outlined
 * circles, the track is thin with a purple fill and a round thumb, elapsed and total sit either
 * side of it, and the speed pill is at the right.
 *
 * **The thumbnail in the left slot is the cover of the series the playing teaching is in** (scope
 * prd 3.2.4) — a recording has no artwork of its own. It is handed over by `open` with the teaching
 * rather than fetched here, because this bar is mounted in the member layout and never remounts:
 * a fetch of its own would be a second answer to a question the recording payload already gave.
 * A teaching in no series, or in one with no cover, leaves the slot to the title beside it, which
 * is what a member actually needs to know is playing (scope prd 3.2.6).
 *
 * **The `···` control** opens the side toolbar of `bottom-navigation/menu-opened.png`. The reference
 * draws seven icons — a book, mind map, a list, an AI action, text size, notes and CC. Three of them
 * have data now: CC, **the speech bubble that opens the composer as a sheet over whatever screen
 * the member is on** (active-scope prd 3.1.2, 5.1.5), and **the list, which is chapters** — the
 * same sheet, holding the playing teaching's chapters so a member can jump to one from any screen
 * without walking to the recording page's tab for it ([3.22.12](docs/project/prd.md)). The other
 * four are dropped rather than rendered disabled, which is the line the whole member surface draws
 * for a deferred destination; the chapters tool joins them whenever the teaching has no chapters
 * ([3.22.4](docs/project/prd.md)).
 *
 * **The note markers** are the notes scope's other change here (3.2.4, 5.7.1–5.7.3): a tick on the
 * progress track at every visible top-level note. They travel with the bar, so a member who walks
 * away from the recording page still sees where the group has annotated the teaching they are
 * hearing — which is the whole reason the notes are owned by the player provider rather than by
 * that page.
 *
 * **The highlight dots** are the member's own moments in this teaching ([3.15.2](docs/project/prd.md)),
 * drawn on the same track in orange so they are told from the notes' green at a glance. They come
 * from the highlights store the marker beside the rate pill reads, so a press there puts a dot on
 * the track in the same render.
 *
 * **The caption pill** is `bottom-navigation/subtitles.png` — the current line floating above the
 * bar, on whichever member screen the listener is on.
 *
 * **The bar renders only when something is loaded**, so the landing before a first play is the
 * reference's layout unchanged.
 *
 * **The left slot opens `pages/player.png`** — the now-playing view (scope prd 3.3.1). It is a link
 * to a route under this same layout, so pressing it re-renders the page slot and leaves this bar
 * and its `<audio>` element exactly where they were (scope prd 3.3.4; scope tdd 1.6). **This bar is
 * still the player**: the view holds no transport control of its own, and every press that changes
 * playback is here.
 */

/** `0` duration means the element has not said yet — an unknown total, not a zero-length teaching. */
function totalLabel(durationMs: number): string {
  return durationMs > 0 ? formatTimecode(durationMs) : '--:--';
}

/**
 * How close two notes have to be to read as one tick — **1% of the recording's duration**
 * (scope prd 3.2.6).
 *
 * Computed here rather than server-side because **nothing in this product stores a duration**: the
 * media element is the only source of one, so the server has no number to collapse against. That is
 * the same fact that makes the composer's anchor a client-side freeze.
 */
const COLLAPSE_FRACTION = 0.01;

/**
 * How long the rate pill must be held before it becomes the picker rather than a step.
 *
 * Long enough that a tap never opens a strip that flashes and closes, short enough that a member
 * who meant to hold is not left pressing a control that has not answered. The platform long-press
 * is around half a second and is a *different* gesture — this one is over before that fires.
 */
const SPEED_HOLD_MS = 220;

/**
 * How long the scrubber must sit still before the position it is showing is actually seeked to.
 *
 * A drag across the track is one gesture, not the hundred positions it passes through, and every
 * one of those would be a `currentTime` write — each of which re-seeks the element and, on a phone
 * over the network, re-buffers. So the thumb and the timecode follow the finger at once and the
 * element is told once the finger settles; short enough that a release feels immediate, long enough
 * that the positions swept on the way are never asked for.
 */
const SCRUB_SETTLE_MS = 100;

/** One tick: where it sits, and every note that reads as being there. */
interface Marker {
  readonly positionMs: number;
  readonly notes: readonly NoteView[];
}

/**
 * Group the visible notes into ticks.
 *
 * The notes arrive in the list's own order — timestamp ascending — so one pass is enough: a note
 * within the window of the tick being built joins it, and anything further along starts the next.
 * A heavily annotated passage therefore renders as one tick rather than a smear, and the tick sits
 * at the **earliest** note in it (2.2.3).
 *
 * **Replies never reach here.** A reply has no position of its own (3.3.2), and the payload says so
 * with a null rather than with a separate shape — so dropping them is one filter and cannot be
 * forgotten by a later reader of this code.
 */
function collapse(notes: readonly NoteView[], durationMs: number): Marker[] {
  const window = durationMs * COLLAPSE_FRACTION;
  const markers: { positionMs: number; notes: NoteView[] }[] = [];

  for (const note of notes) {
    if (note.timestampMs === null) continue;
    const open = markers[markers.length - 1];
    if (open !== undefined && note.timestampMs - open.positionMs < window) open.notes.push(note);
    else markers.push({ positionMs: note.timestampMs, notes: [note] });
  }

  return markers;
}

/**
 * The list icon of `bottom-navigation/menu-opened.png` — three bulleted lines — drawn the way the
 * top navigation draws its icons rather than set as a character, because no character reads as
 * that icon at the size the strip draws it: `☰` is a menu, and a menu inside a menu is what a
 * member would take it for.
 */
function ChaptersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M9 7h11M9 12h11M9 17h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="5" cy="7" r="1.2" fill="currentColor" />
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="5" cy="17" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function TransportBar() {
  const player = usePlayer();
  // Which member screen the bar is docked under — read for one thing only, the caption pill below.
  const pathname = usePathname();
  const { highlights } = useHighlights();
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * The teaching the chapters sheet is open for, or `null` while it is closed.
   *
   * An id rather than a boolean, because the sheet lists **the loaded teaching's** chapters and a
   * different teaching arriving underneath it has to close it rather than refill it: the list a
   * member opened was about one teaching, and a sheet that quietly became about another would send
   * their next press to a chapter they never looked at. Holding the id makes that a comparison at
   * render rather than an effect chasing the load — and it is its own state rather than a second
   * value in `sheetOpen`, because the two sheets are independent: a member may well reach for a
   * chapter with a note half-written, and closing the composer under them to show the list would
   * be answering a question they did not ask.
   */
  const [chaptersOpenFor, setChaptersOpenFor] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  /**
   * The step the thumb is over while the rate picker is held open, or `null` when the picker is
   * closed. One piece of state for both, because a picker with nothing armed is a picker that is
   * not open — the gesture always begins armed at the rate that is already playing.
   */
  const [armedSpeed, setArmedSpeed] = useState<number | null>(null);
  const speedPickerRef = useRef<HTMLDivElement>(null);
  /** Set on the release of a rate gesture, so the click behind it is not read as a second press. */
  const speedHandledRef = useRef(false);

  /**
   * The position the scrubber is showing while it is being dragged, or `null` when the player's own
   * position is what it shows. It exists because the seek is deferred: between the move and the
   * seek that settles it, this is the only place the asked-for position is written down.
   */
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const scrubTimerRef = useRef<number | null>(null);

  // Set by the `···` gesture on release, so the compatibility click it may produce is not read as a
  // second press. A keyboard press clears it first, which is what keeps Enter and Space working.
  const pointerHandledRef = useRef(false);

  // A pending seek belongs to a scrubber that is on screen; unmounting with one armed would seek a
  // player the member has already left.
  useEffect(
    () => () => {
      if (scrubTimerRef.current !== null) window.clearTimeout(scrubTimerRef.current);
    },
    [],
  );

  /*
   * An open toolbar closes on a press anywhere else — the tap-away a member already expects of a
   * menu, and the only way out on touch, where there is no Escape. The `···` is excluded because
   * its own handler is the toggle: closing here first would let the press that shuts the toolbar
   * re-open it. `pointerdown` rather than `click`, so the toolbar is gone before the press lands
   * on the control underneath it, and the listeners exist only while it is open.
   */
  useEffect(() => {
    if (!toolbarOpen) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolbarRef.current?.contains(target)) return;
      if (moreRef.current?.contains(target)) return;
      setToolbarOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setToolbarOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [toolbarOpen]);

  /*
   * The chapters sheet is open when it was opened for the teaching that is loaded now **and** that
   * teaching has chapters to list. The second half matters while a new teaching's list is in
   * flight (`chapters` is `null` then) and for a teaching that has none ([3.22.4](docs/project/prd.md)):
   * both draw no sheet, exactly as both draw no tool. Computed above the early return because the
   * effect below reads it.
   */
  const chapterList = player.chapters?.chapters ?? [];
  const chaptersOpen =
    player.loaded !== null && chaptersOpenFor === player.loaded.id && chapterList.length > 0;

  /*
   * Escape puts the chapters sheet away, the way it puts the toolbar away. The composer's sheet has
   * no such rule, and the difference is deliberate: a list has nothing being typed into it, so
   * Escape can mean only one thing here, where on the composer it would be a second way to abandon
   * a paragraph beside the one explicit `Cancel` that sheet keeps. The listener exists only while
   * the sheet does.
   */
  useEffect(() => {
    if (!chaptersOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setChaptersOpenFor(null);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [chaptersOpen]);

  if (player.loaded === null) return null;

  // The teaching, as a value of its own: the closures below read it, and a narrowing of
  // `player.loaded` does not survive into a callback the way a `const` does.
  const loaded = player.loaded;

  const max = player.durationMs > 0 ? player.durationMs : 0;
  // Mid-drag the scrubber answers to the finger, not to the element that has not been seeked yet.
  const shownMs = scrubMs ?? player.currentMs;
  // A gap between segments answers nothing, and nothing is what the pill shows — a sentence held
  // over a silence is a caption that is wrong rather than late.
  const spoken =
    player.transcript === null ? null : segmentAt(player.transcript.segments, player.currentMs);
  /*
   * The pill shows the segment whole, for the segment's whole duration. It used to be cut into
   * pieces paced across the sentence, so a long one could not grow the pill over the controls —
   * but the provider gives no word-level timing, and pacing by character count drifted against the
   * voice: pieces shown out of step with what was being said read as broken captions, where a tall
   * pill merely reads as a long sentence.
   */
  const caption = spoken === null || spoken.text.trim() === '' ? null : spoken.text;
  // The line read in the highlights orange when it is one of the member's own moments — the same
  // question the transcript tab and the marker beside the rate pill ask of the line playing.
  const captionHighlighted =
    spoken !== null && highlights !== null && momentEntry(highlights, loaded.id, spoken.startMs) !== null;

  /*
   * No duration means no positions to place ticks at, and a failed or empty notes fetch means no
   * ticks to place — both render the plain track of 5.7.3 rather than stale or invented ones. The
   * set is the player's, which is the same set the list renders, so a note cannot leave one and
   * stay in the other (3.5.4).
   */
  const markers = max === 0 ? [] : collapse(player.notes?.notes ?? [], max);

  /*
   * **The chapter boundaries drawn on the track** ([3.22.17](docs/project/prd.md)).
   *
   * The first chapter's start is dropped: it is the start of the teaching, and a division drawn at
   * the very left of a track divides it from nothing. What is left is one line per boundary, which
   * is what "chapters divide the track, notes sit on it" means literally — a full-height rule in the
   * border colour against the note ticks' green pips.
   *
   * No duration means no positions to place them at, exactly as for the note markers, and a teaching
   * with no chapters has none to place.
   */
  const boundaries =
    max === 0 ? [] : (player.chapters?.chapters ?? []).filter((one, index) => index > 0);

  /*
   * **The member's highlighted moments on the track** — every `segment` entry of theirs in this
   * teaching, at the position it was snapped to. A whole-teaching highlight has no position and
   * a highlighted note already has the note's own tick, so neither is drawn.
   */
  const highlightDots =
    max === 0 || highlights === null
      ? []
      : highlights.filter(
          (one) => one.kind === 'segment' && one.recording.id === loaded.id && one.positionMs !== null,
        );

  /*
   * The `···` opens on **press** rather than on release, which is what makes it two controls in one
   * gesture: lift without moving and it behaves as the tap it looks like, or keep holding, slide
   * onto a tool and lift there to fire it — the press-drag-release of a phone's own long-press
   * menus, and one gesture rather than three where the toolbar sits a thumb's width above the bar.
   *
   * The tool is found by hit-testing the release point rather than by the event's target, because
   * touch retargets every move back to the element the press began on; and it is fired by clicking
   * it, so the drag and a plain tap run the very same handler. A release anywhere else closes the
   * toolbar and triggers nothing, which is the escape hatch for a press that was a mistake.
   */
  function openToolbarOnPress(event: ReactPointerEvent<HTMLButtonElement>) {
    // Only the primary button opens it; a right-click belongs to the browser's own menu.
    if (event.button !== 0) return;

    const wasOpen = toolbarOpen;
    pointerHandledRef.current = false;
    setToolbarOpen(true);

    function finish() {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onCancel);
    }

    function onPointerUp(up: PointerEvent) {
      finish();
      pointerHandledRef.current = true;

      const under = document.elementFromPoint(up.clientX, up.clientY);
      const tool = under === null ? null : under.closest('button');

      if (tool !== null && toolbarRef.current?.contains(tool)) {
        // The tool's own handler is the action, and it is what closes the toolbar behind it.
        tool.click();
        return;
      }

      // Lifted on the `···` itself: the tap, so it toggles what the press found.
      if (under !== null && moreRef.current?.contains(under)) {
        setToolbarOpen(!wasOpen);
        return;
      }

      setToolbarOpen(false);
    }

    function onCancel() {
      finish();
      pointerHandledRef.current = true;
      setToolbarOpen(wasOpen);
    }

    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onCancel);
  }

  /*
   * **The rate pill is two controls in one press.** A tap is the step it always was — one press,
   * one step, which is what `bottom-navigation/default.png` draws and what a member reaching for
   * "a bit faster" wants. Held, it opens the whole scale and lets the thumb slide to any step on
   * it, which is the way to 0.5 that does not cost five taps past the one you wanted.
   *
   * The hold is a **timer, not a distance**: a tap must not open a strip that flashes and vanishes,
   * and a member holding still has not moved anywhere to measure. Until it fires the press is a
   * tap; after it, the release is a choice and never a step.
   *
   * The step under the release is found by hit-testing rather than by the event's target, for the
   * reason the `···` gesture gives: touch retargets every move back to the element the press began
   * on, so the target is always the pill.
   */
  function openSpeedPickerOnPress(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    speedHandledRef.current = false;

    let picking = false;
    const hold = window.setTimeout(() => {
      picking = true;
      // Armed at what is playing, so a release that never moved changes nothing.
      setArmedSpeed(player.speed);
    }, SPEED_HOLD_MS);

    function stepUnder(x: number, y: number): number | null {
      const under = document.elementFromPoint(x, y);
      const step = under === null ? null : under.closest('[data-speed]');
      if (step === null || !speedPickerRef.current?.contains(step)) return null;
      const value = Number(step.getAttribute('data-speed'));
      return Number.isNaN(value) ? null : value;
    }

    // A hold is also the browser's own cue to start selecting text and to raise a callout over it,
    // and the strip is drawn over a page full of both. CSS can only say that of the pill and the
    // steps; the drag travels past them, so the press owns these for as long as it lasts.
    function suppressSelection(selection: Event) {
      selection.preventDefault();
    }

    function finish() {
      window.clearTimeout(hold);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('selectstart', suppressSelection);
      document.removeEventListener('contextmenu', suppressSelection);
    }

    function onPointerMove(move: PointerEvent) {
      if (!picking) return;
      // Off the strip the arming holds rather than clearing: a thumb that wanders a few pixels wide
      // of a row has not asked to cancel, and a release out there closes with no change anyway.
      const step = stepUnder(move.clientX, move.clientY);
      if (step !== null) setArmedSpeed(step);
    }

    function onPointerUp(up: PointerEvent) {
      finish();
      speedHandledRef.current = true;

      if (!picking) {
        // Never held: the tap the pill has always been.
        player.cycleSpeed();
        return;
      }

      const step = stepUnder(up.clientX, up.clientY);
      setArmedSpeed(null);
      // Released off the strip — including back on the pill underneath it — is the way out of a
      // hold nobody meant, so it chooses nothing.
      if (step !== null) player.chooseSpeed(step);
    }

    function onCancel() {
      finish();
      speedHandledRef.current = true;
      setArmedSpeed(null);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('selectstart', suppressSelection);
    document.addEventListener('contextmenu', suppressSelection);
  }

  /**
   * Take a position from the scrubber: show it now, seek to it once the drag settles.
   *
   * Each move restarts the timer, so a drag seeks once — at the end — rather than at every pixel it
   * crossed. The shown position is cleared in the same turn the seek is made, and `seekToMs` writes
   * the player's position synchronously, so the thumb never falls back to where it came from.
   */
  function scrubTo(ms: number) {
    setScrubMs(ms);
    if (scrubTimerRef.current !== null) window.clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = window.setTimeout(() => {
      scrubTimerRef.current = null;
      player.seekToMs(ms);
      setScrubMs(null);
    }, SCRUB_SETTLE_MS);
  }

  return (
    <div className={styles.dock}>
      {/*
        **The chapters sheet** — where the list icon goes, over whatever screen the member is on,
        on the composer sheet's pattern beneath it. Every chapter in order with its number, its
        title and the time it starts — the row of [3.22.10](docs/project/prd.md), read here rather
        than on the page — with the chapter playing now marked, and **the whole row opens the
        chapter's page** ([3.22.12](docs/project/prd.md)), as the tab's row does. Opening it does
        not start playback, for the reason the tab gives: a member who tapped a chapter has not
        asked for sound, and the page's own play control is the press that does. The sheet goes
        away on the press, because a member who chose a chapter has finished choosing.

        A link rather than a button, so the row keeps the browser's own behaviours — a new tab, a
        copied address — and so the chapter page is a real navigation with a real entry behind it.
      */}
      {chaptersOpen ? (
        <section className={styles.sheet} aria-label="Jump to a chapter">
          {/*
            Over another screen the title is the only thing that says which teaching these are
            the chapters of — the reason the composer names it above the moment (5.1.5).
          */}
          <p className={styles.sheetTitle} title={loaded.title}>
            {loaded.title}
          </p>
          <ol className={styles.chapterList}>
            {chapterList.map((chapter) => {
              const current = chapter.id === player.currentChapter?.id;
              return (
                <li key={chapter.id}>
                  {/*
                    `aria-current` is what says *playing now* to a screen reader; the accent
                    outline says it to everyone else. The spaces between the three parts are
                    deliberate: a flex row drops them from the layout and keeps them in the name,
                    so the row is announced as "1 The vine 00:00" rather than run together.
                  */}
                  <Link
                    className={`${styles.chapterRow}${
                      current ? ` ${styles.chapterRowCurrent}` : ''
                    }`}
                    href={chapterPagePath(loaded.id, chapter.id)}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => setChaptersOpenFor(null)}
                  >
                    <span className={styles.chapterNumber}>{chapter.position}</span>{' '}
                    <span className={styles.chapterTitle}>{chapter.title}</span>{' '}
                    <time
                      className={styles.chapterStart}
                      dateTime={`PT${Math.round(chapter.startMs / 1000)}S`}
                    >
                      {formatTimecode(chapter.startMs)}
                    </time>
                  </Link>
                </li>
              );
            })}
          </ol>
          <button
            className={styles.sheetClose}
            type="button"
            onClick={() => setChaptersOpenFor(null)}
          >
            Close
          </button>
        </section>
      ) : null}

      {sheetOpen ? (
        <section className={styles.sheet} aria-label="Note composer">
          <NoteComposer
            recordingId={player.loaded.id}
            title={player.loaded.title}
            onSaved={() => setSheetOpen(false)}
          />
          <button
            className={styles.sheetClose}
            type="button"
            onClick={() => {
              setSheetOpen(false);
              player.releaseComposerAnchor();
            }}
          >
            Cancel
          </button>
        </section>
      ) : null}

      {/*
        Captions on means the pill **stays**, silence included. A pill that vanished between lines
        would take the dismiss control with it and shift every control under it back and forth for
        the length of a pause — so a gap draws a dash instead, which says the captions are running
        and this moment has no words rather than leaving a member to wonder which.

        **Not on the now-playing view**, where the same line is already written large across the
        cover: two copies of one sentence stacked on one screen read as a fault, and the view's copy
        is the one that is on purpose. The switch itself is untouched — the pill is back the moment
        the member leaves.
      */}
      {player.captionsOn && pathname !== NOW_PLAYING_PAGE_PATH ? (
        <section className={styles.caption} aria-label="Caption">
          <span className={`${styles.captionText}${captionHighlighted ? ` ${styles.captionHighlighted}` : ''}`}>
            {caption === null ? <span aria-hidden="true">–</span> : caption}
          </span>
          <button
            className={styles.captionDismiss}
            type="button"
            aria-label="Hide captions"
            onClick={() => player.setCaptions(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </section>
      ) : null}

      <section className={styles.bar} aria-label="Player">
        {/*
          **The slot is the way into the now-playing view** (scope prd 3.3.1). The reference draws
          no separate control for it, and the thing a member presses to see what is playing is what
          is playing — so the whole slot takes the press, which is also what keeps the gesture there
          on a teaching that has no cover to press.

          A `Link` rather than a button: scope tdd 1.6 puts the view at a route inside this layout,
          so it has an address, a back button, and a client-side transition that leaves the
          `<audio>` element mounted.

          **It covers the slot rather than wrapping it**, and it carries its own name. A link
          wrapping the tile and the title would take its accessible name from them — and there is
          already a link named after that teaching on the library and on its series page, going
          somewhere else. Two links with one name and two destinations is a thing a member using a
          screen reader cannot tell apart, so the press is a named layer over the slot and the tile
          and the title stay ordinary content, read in their own right.
        */}
        <div className={styles.slot}>
          {/*
            The reference's thumbnail slot, filled at last (scope prd 3.2.4). **Labelled**, unlike
            every other cover in this scope: it stands alone rather than beside a title, so 4.3 asks
            for the series' name on it rather than for silence. Nothing is drawn when there is no
            cover — the title beside it is then the whole of the slot (scope prd 3.2.6).
          */}
          {player.loaded.artworkUrl === null ? null : (
            <img
              className={styles.tile}
              src={player.loaded.artworkUrl}
              alt={player.loaded.seriesTitle ?? ''}
            />
          )}

          <div className={styles.slotText}>
            <p className={styles.nowPlaying} title={player.loaded.title}>
              {player.loaded.title}
            </p>
            {/*
              **The second line: the chapter playing now** ([3.22.16](docs/project/prd.md)).
              A teaching with no chapters shows the series name there, which is what it held before —
              so the line never empties and the bar never changes height under a member.

              Both fall back to nothing when there is neither, which is the coverless, series-less
              teaching the slot already draws as a title alone (scope prd 3.2.6).
            */}
            {player.currentChapter === null && player.loaded.seriesTitle === null ? null : (
              <p
                className={styles.nowPlayingBeneath}
                title={player.currentChapter?.title ?? player.loaded.seriesTitle ?? ''}
              >
                {player.currentChapter?.title ?? player.loaded.seriesTitle}
              </p>
            )}
          </div>

          <Link
            className={styles.slotPress}
            href={NOW_PLAYING_PAGE_PATH}
            aria-label="Open the full player"
          />
        </div>

        <div className={styles.controls}>
          <button
            className={styles.skip}
            type="button"
            aria-label="Back 10 seconds"
            onClick={() => player.skipMs(-10_000)}
          >
            −10
          </button>
          <button
            className={styles.play}
            type="button"
            aria-label={player.playing ? 'Pause' : 'Play'}
            onClick={() => player.toggle()}
          >
            <span aria-hidden="true">{player.playing ? '❚❚' : '▶'}</span>
          </button>
          <button
            className={styles.skip}
            type="button"
            aria-label="Forward 10 seconds"
            onClick={() => player.skipMs(10_000)}
          >
            +10
          </button>
        </div>

        <div className={styles.track}>
          {/*
            The elapsed position, and **only** that. The chapter playing is named on the second line
            of the slot above (3.22.16) and in that one place — naming it here too would put the same
            fact in two places on one bar, and would grow and shrink the label as the teaching moved
            between chapters of different name lengths.
          */}
          <span className={styles.time}>{formatTimecode(shownMs)}</span>
          <div className={styles.scrubberWrap}>
            {/*
              A real range input rather than a styled div: scrubbing has to work with a keyboard and
              be announced as a slider, and the guide's thin track with a purple fill and a round
              thumb is reachable from one without inventing a drag handler.
            */}
            <input
              className={styles.scrubber}
              type="range"
              min={0}
              max={max}
              step={1000}
              value={Math.min(shownMs, max)}
              aria-label="Position"
              disabled={max === 0}
              onChange={(event) => scrubTo(Number(event.target.value))}
            />
            {/*
              A **sibling** layer rather than children of the slider — a range input has no
              children, and a tick inside one would be neither drawn nor placed. The layer takes no
              pointer events and sits under the input's own band, so the ticks read behind the fill
              and the thumb (5.7.1) and scrubbing is untouched (5.7.2).

              `aria-hidden` and not pressable, like the divisions beneath it: a tick says *where*
              the group has annotated the teaching, and the way to a note is the Notes tab — not a
              two-pixel target on a phone. Leaving them unpressable is also what keeps every press
              that lands on the track a scrub.
            */}
            {/*
              **The chapter divisions** ([3.22.17](docs/project/prd.md)), in their own layer under
              the note ticks so the two are told apart by more than colour: a boundary is a full-
              height rule across the track and a note is a pip on it — *chapters divide the track,
              notes sit on it*.

              `aria-hidden` and not pressable, on the same rule the note ticks follow: the way to a
              chapter is the Chapters tab ([3.22.10](docs/project/prd.md)) or the chapter's own
              page, not a two-pixel target on a phone.
            */}
            <div className={styles.boundaries} aria-hidden="true">
              {boundaries.map((chapter) => (
                <span
                  key={chapter.id}
                  className={styles.boundary}
                  style={{ left: `${(chapter.startMs / max) * 100}%` }}
                />
              ))}
            </div>
            <div className={styles.markers} aria-hidden="true">
              {markers.map((marker) => (
                <span
                  key={marker.notes[0]?.id}
                  className={styles.marker}
                  style={{ left: `${(marker.positionMs / max) * 100}%` }}
                />
              ))}
            </div>
            <div className={styles.markers} aria-hidden="true">
              {highlightDots.map((entry) => (
                <span
                  key={entry.id}
                  className={`${styles.marker} ${styles.highlightDot}`}
                  style={{ left: `${((entry.positionMs ?? 0) / max) * 100}%` }}
                />
              ))}
            </div>
          </div>
          <span className={styles.time}>{totalLabel(player.durationMs)}</span>
        </div>

        {/*
          The `···` and the strip it opens, together. The strip hangs off the button rather than
          sitting in the dock's column: opening a menu must not push the caption pill or the note
          composer up the screen, and it must open in the same place every time — which is here,
          over whatever else the dock is showing.
        */}
        <span className={styles.moreSlot}>
          {toolbarOpen ? (
            <nav className={styles.toolbar} ref={toolbarRef} aria-label="Player tools">
              {/*
                **Chapters** — above the speech bubble, where the reference puts the list icon.
                Absent rather than disabled for a teaching with no chapters
                ([3.22.4](docs/project/prd.md)), the line every chapter surface draws and the one the
                recording page draws for its tab ([3.22.10](docs/project/prd.md)). A list that has
                not arrived yet lands here too: it is not a list a member can open.
              */}
              {chapterList.length === 0 ? null : (
                <button
                  className={styles.tool}
                  type="button"
                  aria-label="Chapters"
                  aria-pressed={chaptersOpen}
                  onClick={() => {
                    setToolbarOpen(false);
                    // The same press puts it away, the rule the two tools beside it follow.
                    setChaptersOpenFor(chaptersOpen ? null : loaded.id);
                  }}
                >
                  <ChaptersIcon />
                </button>
              )}
              <button
                className={styles.tool}
                type="button"
                aria-label="Write a note"
                aria-pressed={sheetOpen}
                onClick={() => {
                  setToolbarOpen(false);
                  /*
                   * **The same press puts it away**, the way `CC` beside it does. A member who
                   * opened the composer and then reached back for the same control meant to close
                   * it, and sending them to `Cancel` for that is a second thing to learn for
                   * something they have already said.
                   *
                   * The anchor is released either way — the provider releases it on an open and on
                   * a close alike, because a composer that is not there is composing nothing and
                   * the next one starts from wherever the teaching has reached (3.1.1, 3.1.2).
                   * Opening this way is therefore the same open the Notes tab performs.
                   */
                  player.releaseComposerAnchor();
                  setSheetOpen((open) => !open);
                }}
              >
                <span aria-hidden="true">🗨</span>
              </button>
              <button
                className={styles.tool}
                type="button"
                aria-pressed={player.captionsOn}
                aria-label="Captions"
                onClick={() => {
                  player.setCaptions(!player.captionsOn);
                  setToolbarOpen(false);
                }}
              >
                CC
              </button>
            </nav>
          ) : null}

          <button
            className={styles.more}
            type="button"
            ref={moreRef}
            aria-label="More player controls"
            aria-expanded={toolbarOpen}
            onPointerDown={openToolbarOnPress}
            // Enter and Space reach the button as a click with no pointer sequence behind it, and
            // that is the one click that still toggles. Clearing the flag first is what tells the
            // two apart without reading anything as fragile as the event's detail count.
            onKeyDown={() => {
              pointerHandledRef.current = false;
            }}
            onClick={() => {
              if (pointerHandledRef.current) {
                pointerHandledRef.current = false;
                return;
              }
              setToolbarOpen((open) => !open);
            }}
          >
            <span aria-hidden="true">···</span>
          </button>
        </span>

        {/* Highlight this moment (3.15.2, 3.15.4) — the marker on the bar, left of the rate pill. */}
        <span className={styles.highlightSlot}>
          <PinMomentTool className={styles.highlight} />
        </span>

        {/*
          The rate pill and the scale it opens on a hold, anchored the same way and for the same
          reasons — over the page, and over the pill the thumb is already on. The whole scale is
          drawn, fastest at the top, so moving up moves the rate up.
        */}
        <span className={styles.speedSlot}>
          {armedSpeed === null ? null : (
            <div
              className={styles.speedPicker}
              ref={speedPickerRef}
              role="group"
              aria-label="Playback speed"
            >
              {[...PLAYBACK_SPEEDS].reverse().map((step) => (
                <button
                  key={step}
                  className={`${styles.speedStep}${
                    step === player.speed ? ` ${styles.speedStepCurrent}` : ''
                  }${step === armedSpeed ? ` ${styles.speedStepArmed}` : ''}`}
                  type="button"
                  data-speed={step}
                  aria-pressed={step === player.speed}
                  // The gesture that opened this is what usually chooses; this is for the press
                  // that did not come through it, so a click on a step still means that step.
                  onClick={() => {
                    player.chooseSpeed(step);
                    setArmedSpeed(null);
                  }}
                >
                  {formatPlaybackSpeed(step)}
                </button>
              ))}
            </div>
          )}

          <button
            className={styles.speed}
            type="button"
            aria-label={`Playback speed ${formatPlaybackSpeed(player.speed)}`}
            onPointerDown={openSpeedPickerOnPress}
            // Enter and Space arrive as a click with no pointer sequence behind them, and that is
            // the one click that still steps. Clearing the flag first is what tells the two apart.
            onKeyDown={() => {
              speedHandledRef.current = false;
            }}
            onClick={() => {
              if (speedHandledRef.current) {
                speedHandledRef.current = false;
                return;
              }
              player.cycleSpeed();
            }}
          >
            {formatPlaybackSpeed(player.speed)}
          </button>
        </span>
      </section>
    </div>
  );
}
