'use client';

import { useState } from 'react';
import { formatPlaybackSpeed, formatTimecode } from '@thp/shared';
import { segmentAt } from '@/client/transcript/current-segment';
import { usePlayer } from './player-context';
import styles from './transport.module.css';

/**
 * **The transport** — `bottom-navigation/default.png`, docked to the bottom of every member screen.
 *
 * The reference, read as built: play/pause is the one **filled** purple circle, ±10s are outlined
 * circles, the track is thin with a purple fill and a round thumb, elapsed and total sit either
 * side of it, and the speed pill is at the right.
 *
 * One thing in the reference is not here, and it is the same decision the chrome takes:
 * **the thumbnail in the left slot is artwork**, and artwork is deferred
 * ([epic prd § In scope → 4](docs/epics/epic-core-listening/prd.md)). The slot carries the
 * recording's title instead, which is what a member actually needs to know is playing.
 *
 * **The `···` control** opens the side toolbar of `bottom-navigation/menu-opened.png`. The reference
 * draws seven icons — chapters, mind map, a list, an AI action, text size, notes and CC — and
 * **only CC has data in this epic**. The strip ships holding that one item rather than six that
 * lead nowhere, which is the line the whole member surface already draws for a deferred
 * destination: dropped, not disabled.
 *
 * **The caption pill** is `bottom-navigation/subtitles.png` — the current line floating above the
 * bar, on whichever member screen the listener is on. That is the whole reason the transcript is
 * owned by the player provider rather than by the recording page.
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

export function TransportBar() {
  const player = usePlayer();
  const [toolbarOpen, setToolbarOpen] = useState(false);
  if (player.loaded === null) return null;

  const max = player.durationMs > 0 ? player.durationMs : 0;
  // A gap between segments answers nothing, and nothing is what the pill shows — a sentence held
  // over a silence is a caption that is wrong rather than late.
  const spoken =
    player.transcript === null ? null : segmentAt(player.transcript.segments, player.currentMs);

  return (
    <div className={styles.dock}>
      {toolbarOpen ? (
        <nav className={styles.toolbar} aria-label="Player tools">
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
          {/*
            A real range input rather than a styled div: scrubbing has to work with a keyboard and
            be announced as a slider, and the guide's thin track with a purple fill and a round thumb
            is reachable from one without inventing a drag handler.
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
