import { describe, expect, it } from 'vitest';
import { MIN_STORED_POSITION_MS } from '@thp/shared';
import {
  PROGRESS_TICK_INTERVAL_MS,
  shouldWriteProgress,
  type ProgressEventKind,
} from '@/client/playback/cadence';

/**
 * **How often a position is pushed, and on what** — asserted over elapsed time and event kind, with
 * no clock, no player and no browser involved.
 *
 * That is the whole reason the decision is a pure function. A cadence tested by playing audio for
 * thirty seconds and counting requests takes thirty seconds and still cannot say *why* it wrote
 * when it did; this says exactly that, and the browser suite checks the wiring around it.
 */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const PAST_THE_FLOOR = MIN_STORED_POSITION_MS + 1000;

function ask(over: Partial<Parameters<typeof shouldWriteProgress>[0]>): boolean {
  return shouldWriteProgress({
    event: 'tick',
    positionMs: PAST_THE_FLOOR,
    lastWriteAt: null,
    now: NOW,
    ...over,
  });
}

describe('a position too near the start is never written', () => {
  it.each<ProgressEventKind>(['tick', 'pause', 'seek', 'hide'])(
    'refuses a %s below the floor',
    (event) => {
      // Opening a teaching and closing it must leave nothing behind — otherwise the landing offers
      // a card that resumes at the very beginning, which is worse than no card at all.
      expect(ask({ event, positionMs: MIN_STORED_POSITION_MS - 1 })).toBe(false);
    },
  );

  it('writes at the floor exactly', () => {
    expect(ask({ positionMs: MIN_STORED_POSITION_MS })).toBe(true);
  });

  it('puts the floor at five seconds', () => {
    expect(MIN_STORED_POSITION_MS).toBe(5_000);
  });
});

describe('playback continuing is rate-limited', () => {
  it('writes the first tick, because nothing has been written yet', () => {
    expect(ask({ event: 'tick', lastWriteAt: null })).toBe(true);
  });

  it('refuses a tick inside the interval', () => {
    expect(ask({ event: 'tick', lastWriteAt: NOW - 1_000 })).toBe(false);
    expect(ask({ event: 'tick', lastWriteAt: NOW - (PROGRESS_TICK_INTERVAL_MS - 1) })).toBe(false);
  });

  it('writes a tick at the interval and beyond it', () => {
    expect(ask({ event: 'tick', lastWriteAt: NOW - PROGRESS_TICK_INTERVAL_MS })).toBe(true);
    expect(ask({ event: 'tick', lastWriteAt: NOW - 60_000 })).toBe(true);
  });

  it('bounds the interval at ten seconds', () => {
    expect(PROGRESS_TICK_INTERVAL_MS).toBe(10_000);
  });
});

describe('a deliberate event is never dropped for having happened too soon', () => {
  it.each<ProgressEventKind>(['pause', 'seek', 'hide'])(
    'writes on %s however recently a tick went out',
    (event) => {
      // Each of these is a decision — stopping, choosing a position, leaving. A decision dropped
      // because a tick happened a second ago is a decision lost, and page-hide is the last moment
      // anything is guaranteed to run.
      expect(ask({ event, lastWriteAt: NOW })).toBe(true);
      expect(ask({ event, lastWriteAt: NOW - 1 })).toBe(true);
    },
  );
});

describe('the four kinds are the whole vocabulary', () => {
  it('treats only a tick as rate-limited', () => {
    const kinds: ProgressEventKind[] = ['tick', 'pause', 'seek', 'hide'];
    const limited = kinds.filter((event) => !ask({ event, lastWriteAt: NOW }));
    expect(limited).toEqual(['tick']);
  });
});
