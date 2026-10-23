import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUEUE,
  FREE_SPACE_RESERVE_BYTES,
  cancel,
  enqueue,
  fail,
  finish,
  fitsAlone,
  itemFraction,
  nextQueued,
  overall,
  planSeriesDownload,
  progress,
  prune,
  start,
} from '@/client/offline/queue';

/**
 * **The download queue as a value** (docs/project/prd.md 3.18.7, 3.18.8, 3.18.17).
 *
 * Order, de-duplication, the two progress figures, and the one decision the PRD spells out at
 * length: whether "Download all" is refused before it starts, and which recordings are offered.
 */
const MB = 1024 * 1024;

describe('the queue', () => {
  it('runs items in the order asked, one at a time, and never adds a live one twice', () => {
    let queue = enqueue(EMPTY_QUEUE, { recordingId: 'a', title: 'A', bytes: 10 });
    queue = enqueue(queue, { recordingId: 'b', title: 'B', bytes: 20 });
    queue = enqueue(queue, { recordingId: 'a', title: 'A again', bytes: 10 });
    expect(queue.items.map((one) => one.recordingId)).toEqual(['a', 'b']);
    expect(nextQueued(queue)?.recordingId).toBe('a');

    queue = start(queue, 'a');
    expect(nextQueued(queue)).toBeNull();
    queue = finish(queue, 'a');
    expect(nextQueued(queue)?.recordingId).toBe('b');
  });

  it('replaces a finished, failed or cancelled entry when it is asked for again', () => {
    let queue = enqueue(EMPTY_QUEUE, { recordingId: 'a', title: 'A', bytes: 10 });
    queue = fail(start(queue, 'a'), 'a', 'The store answered 500.');
    expect(queue.items[0]?.status).toBe('failed');
    queue = enqueue(queue, { recordingId: 'a', title: 'A', bytes: 10 });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.status).toBe('queued');
    expect(queue.items[0]?.failure).toBeNull();
  });

  it('reports each item and the whole over the live items only', () => {
    let queue = enqueue(EMPTY_QUEUE, { recordingId: 'a', title: 'A', bytes: 100 });
    queue = enqueue(queue, { recordingId: 'b', title: 'B', bytes: 300 });
    queue = progress(start(queue, 'a'), 'a', 50);
    expect(itemFraction(queue.items[0]!)).toBe(0.5);
    expect(overall(queue)).toEqual({ remaining: 2, loaded: 50, total: 400, fraction: 0.125 });

    queue = finish(queue, 'a');
    expect(itemFraction(queue.items[0]!)).toBe(1);
    // The finished item leaves the overall figure rather than pinning it high.
    expect(overall(queue)).toEqual({ remaining: 1, loaded: 0, total: 300, fraction: 0 });

    queue = cancel(queue, 'b');
    expect(overall(queue).remaining).toBe(0);
    expect(prune(queue).items).toEqual([]);
  });

  it('takes the size the grant answers, after the item was queued without one', () => {
    let queue = enqueue(EMPTY_QUEUE, { recordingId: 'a', title: 'A', bytes: 0 });
    queue = start(queue, 'a', 4_000);
    expect(queue.items[0]?.bytes).toBe(4_000);
    expect(itemFraction(progress(queue, 'a', 1_000).items[0]!)).toBe(0.25);
  });
});

describe('"Download all", before the queue is built (3.18.17)', () => {
  const series = [
    { id: 'newest', title: 'Newest', recordedAt: '2026-03-03', bytes: 60 * MB },
    { id: 'middle', title: 'Middle', recordedAt: '2026-02-02', bytes: 50 * MB },
    { id: 'oldest', title: 'Oldest', recordedAt: '2026-01-01', bytes: 40 * MB },
  ];

  it('fits when the device has the series plus the reserve', () => {
    const plan = planSeriesDownload({
      recordings: series,
      held: new Set(),
      freeBytes: 150 * MB + FREE_SPACE_RESERVE_BYTES,
    });
    expect(plan.fits).toBe(true);
    expect(plan.neededBytes).toBe(150 * MB);
    expect(plan.availableBytes).toBe(150 * MB);
    expect(plan.offered.map((one) => one.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('says what the series needs and what is available, and offers the most recent that fit', () => {
    const plan = planSeriesDownload({
      recordings: series,
      held: new Set(),
      freeBytes: 120 * MB + FREE_SPACE_RESERVE_BYTES,
    });
    expect(plan.fits).toBe(false);
    expect(plan.neededBytes).toBe(150 * MB);
    expect(plan.availableBytes).toBe(120 * MB);
    // Newest and middle (110 MB) fit; the oldest would take it to 150.
    expect(plan.offered.map((one) => one.id)).toEqual(['newest', 'middle']);
  });

  it('offers nothing when not even the newest fits, and the reserve counts against it', () => {
    const plan = planSeriesDownload({ recordings: series, held: new Set(), freeBytes: 60 * MB });
    expect(plan.fits).toBe(false);
    expect(plan.offered).toEqual([]);
  });

  it('does not count what is already held, and is not subject to the check in a store build', () => {
    const held = planSeriesDownload({
      recordings: series,
      held: new Set(['newest']),
      freeBytes: 90 * MB + FREE_SPACE_RESERVE_BYTES,
    });
    expect(held.wanted.map((one) => one.id)).toEqual(['middle', 'oldest']);
    expect(held.fits).toBe(true);

    const shell = planSeriesDownload({ recordings: series, held: new Set(), freeBytes: null });
    expect(shell.fits).toBe(true);
    expect(shell.availableBytes).toBeNull();
    expect(fitsAlone(10 * 1024 * MB, null)).toBe(true);
    expect(fitsAlone(10 * MB, 10 * MB)).toBe(false);
  });
});
