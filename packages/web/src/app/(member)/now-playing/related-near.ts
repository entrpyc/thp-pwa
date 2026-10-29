import type { CrossReferenceGroupView } from '@thp/shared';
import { NOTE_LINGER_MS, NOTE_LOOKAHEAD_MS } from './notes-near';

/**
 * **The related moments near the playhead**, soonest first ([3.9.2](docs/project/prd.md)).
 *
 * A group is anchored to the sentence of *this* teaching that triggered it, and it is that
 * sentence's start the window is measured against — the moment the member hears the thing the
 * other teaching also says. The window is the notes row's, on purpose: the now-playing view is
 * one screen about one stretch of time, and two rows that disagreed about how long "now" lasts
 * would have a note scroll off while the related moment beside it stayed.
 *
 * The recording page's `Related` tab lists every group instead, because a member reading that tab
 * is surveying the whole teaching; here the rows under the hero turn over with the voice, which is
 * what the window is for.
 */
export function relatedNear(
  groups: readonly CrossReferenceGroupView[],
  nowMs: number,
): CrossReferenceGroupView[] {
  return groups
    .filter(
      (group) =>
        group.links.length > 0 &&
        group.startMs - NOTE_LOOKAHEAD_MS <= nowMs &&
        nowMs <= group.startMs + NOTE_LINGER_MS,
    )
    .sort((a, b) => a.startMs - b.startMs);
}
