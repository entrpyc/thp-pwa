'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  NOW_PLAYING_PAGE_PATH,
  PLAYBACK_SPEEDS,
  chapterAt,
  formatPlaybackSpeed,
  formatTimecode,
  type ChapterView,
  type NoteView,
} from '@thp/shared';
import { segmentAt } from '@/client/transcript/current-segment';
import { NoteComposer } from './recordings/[id]/note-composer';
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
 * draws seven icons — chapters, mind map, a list, an AI action, text size, notes and CC. Two of them
 * have data now: CC, and **the speech bubble that opens the composer as a sheet over whatever screen
 * the member is on** (active-scope prd 3.1.2, 5.1.5). The other five are dropped rather than
 * rendered disabled, which is the line the whole member surface draws for a deferred destination.
 *
 * **The note markers** are the notes scope's other change here (3.2.4, 5.7.1–5.7.3): a tick on the
 * progress track at every visible top-level note. They travel with the bar, so a member who walks
 * away from the recording page still sees where the group has annotated the teaching they are
 * hearing — which is the whole reason the notes are owned by the player provider rather than by
 * that page.
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
 * A heavily annotated passage therefore renders as one pressable tick rather than an unpressable
 * smear, and the tick sits at the **earliest** note in it, which is where pressing it seeks to
 * (2.2.3).
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

/** What a screen reader says for a tick (scope prd 5.7.2). */
function markerLabel(marker: Marker): string {
  const at = formatTimecode(marker.positionMs);
  return marker.notes.length === 1
    ? `Note at ${at}`
    : `${marker.notes.length} notes from ${at}`;
}

/**
 * **What the position label says while the track is being moved along**
 * ([3.22.18](docs/project/prd.md)).
 *
 * The timecode, and the chapter the thumb is passing through when there is one — so a member
 * dragging toward a part of the teaching sees what they are dragging *into* rather than a number
 * alone. The chapter is found by the same `chapterAt` the transport's own second line uses, over
 * the same list, so the two cannot name different chapters for one moment.
 *
 * Where a pointer can hover, hovering shows the same thing: the hover and the drag both come through
 * here, because they are the same question asked of a different position.
 */
function positionLabel(chapters: readonly ChapterView[], atMs: number): string {
  const chapter = chapterAt(chapters, atMs);
  const at = formatTimecode(atMs);
  return chapter === null ? at : `${at} · ${chapter.title}`;
}

export function TransportBar() {
  const player = usePlayer();
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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

  /**
   * The position a pointer is **hovering** over the track, or `null`
   * ([3.22.18](docs/project/prd.md) — "where a pointer can hover, hovering shows the same thing").
   *
   * Separate from {@link scrubMs} because they are different states: a drag has asked to *go*
   * somewhere and a hover has asked *what is there*. Kept apart, a hover that wanders across a
   * settled drag cannot cancel the seek it is about to make.
   *
   * It is never set on a touch device, where `pointerover` does not fire without a press — which is
   * exactly the "where a pointer can hover" the requirement scopes itself to.
   */
  const [hoverMs, setHoverMs] = useState<number | null>(null);

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

  if (player.loaded === null) return null;

  const max = player.durationMs > 0 ? player.durationMs : 0;
  // Mid-drag the scrubber answers to the finger, not to the element that has not been seeked yet.
  const shownMs = scrubMs ?? player.currentMs;
  // A gap between segments answers nothing, and nothing is what the pill shows — a sentence held
  // over a silence is a caption that is wrong rather than late.
  const spoken =
    player.transcript === null ? null : segmentAt(player.transcript.segments, player.currentMs);

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
   * What the elapsed label reads while the track is being moved along or hovered over
   * ([3.22.18](docs/project/prd.md)). Neither is happening on the ordinary tick, and then it is the
   * timecode it has always been.
   */
  const pointedAt = scrubMs ?? hoverMs;
  const elapsedLabel =
    pointedAt === null
      ? formatTimecode(shownMs)
      : positionLabel(player.chapters?.chapters ?? [], pointedAt);

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
      */}
      {player.captionsOn ? (
        <section className={styles.caption} aria-label="Caption">
          <span className={styles.captionText}>
            {spoken === null ? <span aria-hidden="true">–</span> : spoken.text}
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
            The elapsed position, and — while the track is being dragged or hovered — the chapter
            under the thumb beside it ([3.22.18](docs/project/prd.md)). `aria-live="polite"` so a
            member using a screen reader hears what they are dragging into rather than only being
            able to read it.
          */}
          <span className={styles.time} aria-live="polite">
            {elapsedLabel}
          </span>
          <div
            className={styles.scrubberWrap}
            onPointerMove={(event) => {
              // Hover only — a pointer that is pressed is a drag, and the drag owns the label.
              if (max === 0 || event.buttons !== 0) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (box.width === 0) return;
              const across = (event.clientX - box.left) / box.width;
              setHoverMs(Math.round(Math.min(1, Math.max(0, across)) * max));
            }}
            onPointerLeave={() => setHoverMs(null)}
          >
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
              A **sibling** layer rather than children of the slider — a range input has no children,
              and a marker inside one would be neither focusable nor announced. The layer takes no
              pointer events and sits under the input's own band, so the ticks read behind the fill
              and the thumb (5.7.1) and scrubbing is untouched (5.7.2); each tick stands a little
              proud of that band, which is the part a pointer can press.
            */}
            {/*
              **The chapter divisions** ([3.22.17](docs/project/prd.md)), in their own layer under
              the note ticks so the two are told apart by more than colour: a boundary is a full-
              height rule across the track and a note is a pip on it — *chapters divide the track,
              notes sit on it*.

              `aria-hidden` and not pressable, deliberately. A note marker is a destination a member
              asked for; a boundary is a division of the thing they are already looking at, and the
              way to a chapter is the Chapters tab ([3.22.10](docs/project/prd.md)) or the chapter's
              own page — not a two-pixel target on a phone. Leaving them unpressable is also what
              keeps every press that lands on the track a scrub.
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
            <div className={styles.markers} aria-hidden={markers.length === 0}>
              {markers.map((marker) => (
                <button
                  key={marker.notes[0]?.id}
                  className={styles.marker}
                  type="button"
                  style={{ left: `${(marker.positionMs / max) * 100}%` }}
                  aria-label={markerLabel(marker)}
                  onClick={() => {
                    // Seeks and does not play — the same rule selecting a transcript line follows
                    // (3.2.5). The earliest note in a collapsed tick is where both go (3.2.6).
                    player.seekToMs(marker.positionMs);
                    const first = marker.notes[0];
                    if (first !== undefined) player.revealNote(first.id);
                  }}
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
