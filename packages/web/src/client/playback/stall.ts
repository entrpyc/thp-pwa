/**
 * **A press for sound that produced no sound** ([3.2.6](docs/project/prd.md)).
 *
 * The ticket: a member paused a teaching from the headset with the phone locked, and pressed the
 * headset again. The lock screen flipped to "playing" and its clock began to move, the bar in the
 * app said "playing" when the phone was unlocked — and nothing was heard, and the app's own clock
 * stood still. Pressing the bar twice, pause and then play, brought the sound back.
 *
 * What had happened is that the element did what it was asked — `paused` went `false` and the
 * `play` event fired, which is what both surfaces draw from — and the WebView's audio pipeline,
 * resumed from a background with the screen off, never actually started. Nothing in the element's
 * events says so: no `error`, no `pause`, no `stalled` for a source that is fine. The one thing
 * that tells the truth is the media clock, which goes on reading what it read at the press.
 *
 * So the player **checks that a press for sound produced sound**, a moment after each `play`, by
 * reading the clock — and when it has not moved, does what the member did: pauses and plays again.
 * If that does not take either, it does the stronger thing a grant renewal already does, pointing
 * the element at a fresh source with the position in hand. And then it stops: a clock that will
 * not move after both is a network that is not delivering, and that is the ticker's and the
 * member's to see, not a loop's.
 *
 * Pure, for the reason `renewal.ts` and `cadence.ts` are: the player is the wiring that reads the
 * element on a timer and acts; what to do with the readings is decided here, where it is
 * assertable without a browser.
 */

/**
 * How long after `play` the clock is read. Long enough for an honest pipeline to resume — a
 * suspended one has to reopen the audio device and fetch a range — and short enough that a member
 * who pressed the headset is not left in silence wondering.
 */
export const SOUND_CHECK_MS = 2_000;

/**
 * The least the clock must have moved to count as sound. `timeupdate` fires at least four times a
 * second while playing, so a pipeline that is running has moved the clock well past this inside
 * the check's window; a stalled one reads exactly what it read at the press.
 */
export const SOUND_EPSILON_SECONDS = 0.1;

export interface SoundCheckInput {
  /** The element's `paused` at the check. */
  readonly paused: boolean;
  /** Whether the member still wants sound: a pause since the press cancels the check. */
  readonly wantsPlay: boolean;
  /** The media clock, in seconds, when `play` fired. */
  readonly startedAtSeconds: number;
  /** The media clock, in seconds, at the check. */
  readonly nowSeconds: number;
  /** How many remedies this press has already had. */
  readonly remedies: number;
}

/**
 * What the check decides.
 *
 * - `none` — sound is being produced, or the member no longer wants it. Nothing to do.
 * - `replay` — the clock has not moved: pause and play again, which is the member's own remedy.
 * - `reload` — it still has not moved: swap the source with the position in hand, as a renewal does.
 * - `leave` — both have been tried; the fault is not the pipeline's.
 */
export type SoundRemedy = 'none' | 'replay' | 'reload' | 'leave';

export function soundRemedy({
  paused,
  wantsPlay,
  startedAtSeconds,
  nowSeconds,
  remedies,
}: SoundCheckInput): SoundRemedy {
  if (paused || !wantsPlay) return 'none';
  if (nowSeconds - startedAtSeconds >= SOUND_EPSILON_SECONDS) return 'none';
  if (remedies === 0) return 'replay';
  if (remedies === 1) return 'reload';
  return 'leave';
}
