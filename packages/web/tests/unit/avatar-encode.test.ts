import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_EDGE, centreSquare } from '@/client/artwork/encode';

/**
 * **The square the browser cuts an avatar to** (docs/project/prd.md 3.1.12).
 *
 * The decision is a pure function for the reason the cover's `fitWithin` is: a canvas cannot be
 * driven from Node, and what the browser suite asserts is what lands in the bucket. What is pinned
 * here is the rule that differs from the cover's — **the shape does not survive.** An avatar is
 * drawn in exactly one shape everywhere, so the centre square is taken once, here, rather than by
 * whichever surface happens to draw it.
 */

describe('an avatar is the centre square of what was chosen', () => {
  it('bounds the stored edge at 512', () => {
    // The literal, not the module's own constant read back at itself.
    expect(AVATAR_MAX_EDGE).toBe(512);
  });

  it('takes the shorter edge as the square, centred on the longer one', () => {
    expect(centreSquare(4000, 3000)).toEqual({ x: 500, y: 0, size: 3000 });
    expect(centreSquare(3000, 4000)).toEqual({ x: 0, y: 500, size: 3000 });
  });

  it('leaves a square alone', () => {
    expect(centreSquare(3000, 3000)).toEqual({ x: 0, y: 0, size: 3000 });
  });

  it('rounds an odd margin down rather than reading half a pixel', () => {
    expect(centreSquare(101, 100)).toEqual({ x: 0, y: 0, size: 100 });
    expect(centreSquare(103, 100)).toEqual({ x: 1, y: 0, size: 100 });
  });

  it('never produces a square of nothing', () => {
    expect(centreSquare(0, 500).size).toBe(1);
  });
});
