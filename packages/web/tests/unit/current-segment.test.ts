import { describe, expect, it } from 'vitest';
import { segmentAt } from '@/client/transcript/current-segment';

/**
 * **`segmentAt`, driven across every kind of offset there is** (Story 5 Ticket 01).
 *
 * The function is pure, so this suite needs no clock, no element and no browser — which is the
 * whole reason it is a module rather than a `find` inside the transcript component. The four
 * features that later resolve "open at the moment" through the same pair
 * (docs/epics/epic-core-listening/architecture.md § Extension points) inherit exactly these
 * answers.
 */

/** A known transcript with a deliberate silence in it: 4000–6000 belongs to nobody. */
const SEGMENTS = [
  { id: 'a', startMs: 0, endMs: 1500 },
  { id: 'b', startMs: 1500, endMs: 4000 },
  // the gap
  { id: 'c', startMs: 6000, endMs: 9000 },
  { id: 'd', startMs: 9000, endMs: 12_000 },
] as const;

describe('which segment covers an offset', () => {
  it('answers the segment an offset sits inside', () => {
    expect(segmentAt(SEGMENTS, 800)?.id).toBe('a');
    expect(segmentAt(SEGMENTS, 2000)?.id).toBe('b');
    expect(segmentAt(SEGMENTS, 7500)?.id).toBe('c');
    expect(segmentAt(SEGMENTS, 11_999)?.id).toBe('d');
  });

  it('treats the start as inclusive and the end as exclusive', () => {
    // The one millisecond two adjacent segments touch at has exactly one owner, and it is the
    // later one — which is what the shared `Segment` type documents.
    expect(segmentAt(SEGMENTS, 1500)?.id).toBe('b');
    expect(segmentAt(SEGMENTS, 1499)?.id).toBe('a');
    expect(segmentAt(SEGMENTS, 9000)?.id).toBe('d');
    expect(segmentAt(SEGMENTS, 8999)?.id).toBe('c');
    // And the very first millisecond of the transcript belongs to the first line.
    expect(segmentAt(SEGMENTS, 0)?.id).toBe('a');
  });

  it('answers nothing inside a gap rather than the nearest line', () => {
    // A silence is a real answer. Holding the previous sentence over it would put words on screen
    // that nobody is saying.
    expect(segmentAt(SEGMENTS, 4000)).toBeNull();
    expect(segmentAt(SEGMENTS, 5000)).toBeNull();
    expect(segmentAt(SEGMENTS, 5999)).toBeNull();
  });

  it('answers nothing past the end of the last segment', () => {
    expect(segmentAt(SEGMENTS, 12_000)).toBeNull();
    expect(segmentAt(SEGMENTS, 600_000)).toBeNull();
  });

  it('answers nothing before the transcript starts, and for an empty transcript', () => {
    expect(segmentAt([{ id: 'late', startMs: 5000, endMs: 6000 }], 0)).toBeNull();
    expect(segmentAt([], 0)).toBeNull();
    expect(segmentAt([], 42)).toBeNull();
  });

  it('agrees with a linear scan at every millisecond of a transcript', () => {
    // The binary search is an optimisation over the obvious answer, so the obvious answer is what
    // it is checked against — every offset from before the start to past the end, gaps included.
    for (let offset = -1; offset <= 12_500; offset += 1) {
      const scanned =
        SEGMENTS.find((one) => offset >= one.startMs && offset < one.endMs) ?? null;
      expect(segmentAt(SEGMENTS, offset)?.id ?? null, `offset ${offset}`).toBe(
        scanned?.id ?? null,
      );
    }
  });

  it('finds a segment in the middle of a transcript the size of a real teaching', () => {
    // ~900 segments is a 90-minute teaching, and this runs on every `timeupdate` — the reason the
    // lookup is a binary search rather than a scan.
    const many = Array.from({ length: 900 }, (_, index) => ({
      id: `s${index}`,
      startMs: index * 6000,
      endMs: index * 6000 + 5500,
    }));

    expect(segmentAt(many, 450 * 6000 + 100)?.id).toBe('s450');
    expect(segmentAt(many, 899 * 6000)?.id).toBe('s899');
    // Every segment is followed by a 500 ms silence in this fixture, and none of them answer.
    expect(segmentAt(many, 450 * 6000 + 5700)).toBeNull();
  });
});
