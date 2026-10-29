import { describe, expect, it } from 'vitest';
import type { CrossReferenceGroupView, RelatedSegmentView } from '@thp/shared';
import { NOTE_LINGER_MS, NOTE_LOOKAHEAD_MS } from '@/app/(member)/now-playing/notes-near';
import { relatedNear } from '@/app/(member)/now-playing/related-near';

/**
 * **The window the now-playing view reads related moments through** ([3.9.2](docs/project/prd.md)).
 *
 * Pinned as arithmetic, and pinned to the notes row's constants: it is the triggering sentence's
 * start that is measured, two minutes ahead and two minutes back with both edges inclusive; it
 * lists soonest first; and a group that carries no link is not a moment to show.
 */
const link: RelatedSegmentView = {
  recordingId: 'other',
  title: 'Other',
  series: null,
  segmentId: 'other-seg',
  startMs: 1_000,
  text: 'text',
  score: 0.9,
  basis: 'semantic',
};

function group(
  overrides: Partial<CrossReferenceGroupView> & { segmentId: string },
): CrossReferenceGroupView {
  return {
    startMs: 0,
    endMs: 2_000,
    text: 'sentence',
    chapterId: null,
    links: [link],
    ...overrides,
  };
}

describe('relatedNear', () => {
  it('looks two minutes ahead and two minutes back from the triggering sentence, edges included', () => {
    const groups = [
      group({ segmentId: 'just-ahead', startMs: 60_000 + NOTE_LOOKAHEAD_MS }),
      group({ segmentId: 'too-far-ahead', startMs: 60_000 + NOTE_LOOKAHEAD_MS + 1 }),
      group({ segmentId: 'just-past', startMs: 60_000 - NOTE_LINGER_MS }),
      group({ segmentId: 'too-long-past', startMs: 60_000 - NOTE_LINGER_MS - 1 }),
      group({ segmentId: 'now', startMs: 60_000 }),
    ];
    expect(relatedNear(groups, 60_000).map((one) => one.segmentId)).toEqual([
      'just-past',
      'now',
      'just-ahead',
    ]);
  });

  it('lists soonest first whatever order the groups arrived in', () => {
    const groups = [
      group({ segmentId: 'c', startMs: 30_000 }),
      group({ segmentId: 'a', startMs: 10_000 }),
      group({ segmentId: 'b', startMs: 20_000 }),
    ];
    expect(relatedNear(groups, 0).map((one) => one.segmentId)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out a group with no link to offer', () => {
    const groups = [group({ segmentId: 'empty', links: [] }), group({ segmentId: 'kept' })];
    expect(relatedNear(groups, 0).map((one) => one.segmentId)).toEqual(['kept']);
  });

  it('answers an empty list when nothing is near', () => {
    expect(relatedNear([group({ segmentId: 'late', startMs: 300_000 })], 0)).toEqual([]);
    expect(relatedNear([group({ segmentId: 'long-gone', startMs: 0 })], 300_000)).toEqual([]);
    expect(relatedNear([], 0)).toEqual([]);
  });
});
