import { ARTWORK_OUTPUT_TYPE } from '@/client/artwork/encode';

/**
 * **What the device is told about the teaching playing** ([3.2.6](docs/project/prd.md)).
 *
 * A phone's lock screen, its notification shade and the one button on a headset are all driven by
 * the Media Session API: the page says what is playing, declares where it has got to, and names a
 * handler for each button, and the platform draws the rest. The player is where those calls are
 * made, because the player owns the element and the loaded teaching. What is decided **here** is
 * the two parts that are data rather than wiring — what is said about a teaching, and when a
 * position is true enough to declare — as pure functions, for the reason `renewal.ts` and
 * `cadence.ts` are: each is assertable without a browser, and the player is then only the wiring
 * that reads the element and passes the answer on.
 *
 * Nothing in this file reads `navigator`. Where there is no media session the player makes none of
 * these calls, and that is the whole of the degradation: a browser without one plays exactly as
 * before, with no lock-screen controls rather than a broken player.
 */

/**
 * Ten seconds — the step the transport's own back and forward controls take
 * ([3.2.9](docs/project/prd.md)), and so the step the lock screen's take too.
 *
 * A platform may suggest its own offset with a `seekOffset` on the action, and it is deliberately
 * not honoured: a member who learns that the bar moves ten seconds should find the lock screen
 * moves the same ten, not whatever a given phone's default happens to be.
 */
export const SKIP_STEP_MS = 10_000;

/**
 * What the lock screen names about a teaching — structural rather than the player's own
 * `LoadedRecording`, so this file depends on nothing under `app/`.
 */
export interface MediaSessionSubject {
  readonly title: string;
  /** The series' title, or `null` for a teaching in none ([3.3.9](docs/project/prd.md)). */
  readonly seriesTitle: string | null;
  /** The series' cover, or `null` when there is none to show. */
  readonly artworkUrl: string | null;
}

/**
 * The metadata to hand the device: the teaching as the title, **its series as the artist**, and
 * the series' cover as the artwork.
 *
 * The series stands where a lock screen expects a performer because that is the fact a member
 * glancing at a locked phone wants beneath the title — which study this is part of — and it is
 * what the transport's own second line shows for a teaching with no chapters (3.22.16). A teaching
 * in no series is named by its title alone: no artist and no artwork rather than a placeholder,
 * which is the answer every other surface gives such a teaching ([3.2.15](docs/project/prd.md)).
 *
 * The cover is declared with its type because every cover is re-encoded to one format before it
 * is stored (`client/artwork/encode.ts`), and a platform that cannot decode it is better told so
 * than left to fetch it and find out. No `sizes`: the encoder keeps whatever shape was uploaded.
 */
export function mediaMetadataFor(subject: MediaSessionSubject): MediaMetadataInit {
  return {
    title: subject.title,
    ...(subject.seriesTitle === null ? {} : { artist: subject.seriesTitle }),
    artwork:
      subject.artworkUrl === null ? [] : [{ src: subject.artworkUrl, type: ARTWORK_OUTPUT_TYPE }],
  };
}

/** A reading off the element, in the element's own units. */
export interface PositionReading {
  /** `element.duration`: `NaN` before metadata has arrived, `Infinity` for a stream. */
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  readonly playbackRate: number;
}

/**
 * The position state to declare, or **`null` when there is nothing true to declare** — in which
 * case the caller clears what the device holds rather than leaving it to extrapolate from a
 * reading that no longer describes anything.
 *
 * The platform refuses, by throwing, a state whose duration is missing or not finite, whose
 * position lies outside `[0, duration]`, or whose rate is zero. Each is a reading the element
 * genuinely produces: `NaN` for the duration before metadata and after the source is dropped,
 * `Infinity` for a live stream, and a `currentTime` a hair past `duration` at the very end of a
 * teaching. So the decision is made here, once, from numbers, rather than by catching the throw
 * four times a second.
 */
export function positionStateFor({
  durationSeconds,
  positionSeconds,
  playbackRate,
}: PositionReading): MediaPositionState | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  if (!Number.isFinite(positionSeconds)) return null;
  if (!Number.isFinite(playbackRate) || playbackRate === 0) return null;
  return {
    duration: durationSeconds,
    position: Math.min(Math.max(0, positionSeconds), durationSeconds),
    playbackRate,
  };
}
