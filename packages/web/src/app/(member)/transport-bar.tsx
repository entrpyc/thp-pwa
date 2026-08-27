'use client';

import { useState } from 'react';
import { formatPlaybackSpeed, formatTimecode, type NoteView } from '@thp/shared';
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
 * `pages/player.png` — the now-playing screen — ships nothing in this epic: its two contents are
 * hero artwork and a scripture-reference list, both deferred. **This bar is the player.**
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

export function TransportBar() {
  const player = usePlayer();
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  if (player.loaded === null) return null;

  const max = player.durationMs > 0 ? player.durationMs : 0;
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

  return (
    <div className={styles.dock}>
      {toolbarOpen ? (
        <nav className={styles.toolbar} aria-label="Player tools">
          <button
            className={styles.tool}
            type="button"
            aria-label="Write a note"
            onClick={() => {
              // The sheet opens armed, exactly as the tab does — one player, one moment, so the
              // two entry points cannot disagree about which one a note carries (3.1.1, 3.1.2).
              player.releaseComposerAnchor();
              setSheetOpen(true);
              setToolbarOpen(false);
            }}
          >
            <span aria-hidden="true">🗨</span>
          </button>
          <button
            className={styles.tool}
            type="button"
            aria-pressed={player.captionsOn}
            aria-label="Captions"
            onClick={() => player.setCaptions(!player.captionsOn)}
          >
            CC
          </button>
        </nav>
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

      {player.captionsOn && spoken !== null ? (
        <section className={styles.caption} aria-label="Caption">
          <span className={styles.captionText}>{spoken.text}</span>
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

        <p className={styles.nowPlaying} title={player.loaded.title}>
          {player.loaded.title}
        </p>

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
          <span className={styles.time}>{formatTimecode(player.currentMs)}</span>
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
              value={Math.min(player.currentMs, max)}
              aria-label="Position"
              disabled={max === 0}
              onChange={(event) => player.seekToMs(Number(event.target.value))}
            />
            {/*
              A **sibling** layer rather than children of the slider — a range input has no children,
              and a marker inside one would be neither focusable nor announced. The layer takes no
              pointer events and sits under the input's own band, so the ticks read behind the fill
              and the thumb (5.7.1) and scrubbing is untouched (5.7.2); each tick stands a little
              proud of that band, which is the part a pointer can press.
            */}
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

        <button
          className={styles.more}
          type="button"
          aria-label="More player controls"
          aria-expanded={toolbarOpen}
          onClick={() => setToolbarOpen((open) => !open)}
        >
          <span aria-hidden="true">···</span>
        </button>

        <button
          className={styles.speed}
          type="button"
          aria-label={`Playback speed ${formatPlaybackSpeed(player.speed)}`}
          onClick={() => player.cycleSpeed()}
        >
          {formatPlaybackSpeed(player.speed)}
        </button>
      </section>
    </div>
  );
}
