import { UNSNAPPED_MOMENT_WINDOW_MS, type HighlightView } from '@thp/shared';

/**
 * **Which entry a control is about**, read off the list — pure, so every pin control answers
 * "is this pinned already" the same way and a unit test can say so without a browser.
 *
 * Each returns the entry to *unpin* when the control is pressed, or `null` when the press should
 * pin. The list is the member's own as the API answered it; nothing here fetches.
 */

/** The whole-teaching entry for this recording ([3.15.1](docs/project/prd.md)), or `null`. */
export function recordingEntry(
  highlights: readonly HighlightView[],
  recordingId: string,
): HighlightView | null {
  return highlights.find((one) => one.kind === 'recording' && one.recording.id === recordingId) ?? null;
}

/** The entry pinning this note ([3.15.3](docs/project/prd.md)), or `null`. */
export function noteEntry(highlights: readonly HighlightView[], noteId: string): HighlightView | null {
  return highlights.find((one) => one.kind === 'note' && one.note?.id === noteId) ?? null;
}

/**
 * The segment entry **this moment is inside** ([3.15.2](docs/project/prd.md)), or `null`.
 *
 * A snapped entry covers its line — start inclusive, end exclusive, the span the server stored it
 * for — so the transport reads "pinned" for as long as that sentence is playing, and a press
 * anywhere in it is the press that unpins. An entry that could not be snapped has no line, so a
 * window either side of its position stands in (`UNSNAPPED_MOMENT_WINDOW_MS`). When two entries
 * could both claim the moment — a snapped line and an unsnapped position a transcript re-run
 * orphaned beside it — the nearer start wins, which is the one a member would call "this one".
 */
export function momentEntry(
  highlights: readonly HighlightView[],
  recordingId: string,
  positionMs: number,
): HighlightView | null {
  let best: HighlightView | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const one of highlights) {
    if (one.kind !== 'segment' || one.recording.id !== recordingId || one.positionMs === null) continue;
    const covers =
      one.segment !== null
        ? positionMs >= one.segment.startMs && positionMs < one.segment.endMs
        : Math.abs(positionMs - one.positionMs) < UNSNAPPED_MOMENT_WINDOW_MS;
    if (!covers) continue;
    const distance = Math.abs(positionMs - one.positionMs);
    if (distance < bestDistance) {
      best = one;
      bestDistance = distance;
    }
  }
  return best;
}
