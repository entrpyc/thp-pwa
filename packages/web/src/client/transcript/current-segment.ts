/**
 * **Which segment covers this offset.**
 *
 * `(recording_id, timestamp_ms)` is the pair
 * core-listening scope tdd § Extension points names as the seam notes,
 * cross-references, search and the Flow Tracker all resolve "open at the moment" through. This is
 * where that pair stops being a schema comment and becomes an answer, and it is **a pure function
 * in its own module** for exactly that reason: the follow-along list and the caption pill both call
 * it today, and the next four features would each otherwise write their own `find` inside a
 * component.
 *
 * The same shape `playback/cadence.ts` already set — the decision is testable without a clock, an
 * element or a browser.
 *
 * Three rules, and each is a real answer rather than a convenience:
 *
 * - **`startMs` inclusive, `endMs` exclusive**, matching what the shared `Segment` type documents.
 *   Two adjacent segments touching at one millisecond have exactly one owner of it.
 * - **A gap answers nothing.** An offset in a silence between two segments is not "the previous
 *   line still" — nobody is speaking, and the caption pill shows nothing rather than holding a
 *   sentence over. Past the end of the last segment is the same answer.
 * - **Binary search rather than a scan**, because this runs on every `timeupdate` — four times a
 *   second, against ~900 segments, for ninety minutes.
 */

/** The least a segment has to be for this to place it. */
export interface SegmentBounds {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The segment covering `offsetMs`, or `null` when none does.
 *
 * `segments` must be in playback order and non-overlapping — which is what the correction route's
 * neighbour rule exists to keep true, and what the query's `(transcript_id, start_ms)` ordering
 * delivers.
 */
export function segmentAt<TSegment extends SegmentBounds>(
  segments: readonly TSegment[],
  offsetMs: number,
): TSegment | null {
  let low = 0;
  let high = segments.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = segments[middle];
    if (candidate === undefined) return null;

    if (offsetMs < candidate.startMs) high = middle - 1;
    else if (offsetMs >= candidate.endMs) low = middle + 1;
    else return candidate;
  }

  return null;
}
