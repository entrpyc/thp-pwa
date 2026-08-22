import { MIN_STORED_POSITION_MS } from '@thp/shared';

/**
 * **How often a position is pushed, and on what.**
 *
 * A player that wrote on every `timeupdate` would make four requests a second per listener for
 * ninety minutes, to store a number that changes by 250ms each time. A player that wrote only on
 * unload would lose the position of every sitting a browser killed. So the rule is a bounded
 * cadence plus the events that actually mean something, and it is **a pure function over elapsed
 * time and event kind** — which is what makes it assertable without a clock, a player or a browser.
 *
 * The four events are not interchangeable:
 *
 * - **`tick`** — playback continuing. Rate-limited, because nothing has happened.
 * - **`pause`** — the member stopped. The single most likely last moment of a sitting.
 * - **`seek`** — the member moved deliberately, and the position they chose is worth more than the
 *   one they drifted to.
 * - **`hide`** — the tab went away. On a phone this is usually the end, and it is the last moment
 *   anything is guaranteed to run.
 *
 * The three deliberate events are never rate-limited: each is a *decision*, and a decision dropped
 * because a tick happened nine seconds ago is a decision lost.
 */

export type ProgressEventKind = 'tick' | 'pause' | 'seek' | 'hide';

/**
 * Ten seconds.
 *
 * The most a member can lose to the cadence alone if everything else fails — and at nine listeners
 * an hour it is nine requests each, which is nothing. Shorter buys less than it costs; longer
 * starts being a noticeable jump backwards.
 */
export const PROGRESS_TICK_INTERVAL_MS = 10_000;

export interface ProgressWriteInput {
  readonly event: ProgressEventKind;
  readonly positionMs: number;
  /** When the last write went out, in epoch milliseconds. `null` when none has. */
  readonly lastWriteAt: number | null;
  readonly now: number;
}

/**
 * Whether this event should produce a write.
 *
 * The floor comes first and applies to every kind: a position under
 * {@link MIN_STORED_POSITION_MS} is not a resume point, so opening a teaching and closing it
 * leaves nothing behind. The API refuses such a write too — this is what stops it being made.
 */
export function shouldWriteProgress({
  event,
  positionMs,
  lastWriteAt,
  now,
}: ProgressWriteInput): boolean {
  if (positionMs < MIN_STORED_POSITION_MS) return false;
  if (event !== 'tick') return true;
  return lastWriteAt === null || now - lastWriteAt >= PROGRESS_TICK_INTERVAL_MS;
}
