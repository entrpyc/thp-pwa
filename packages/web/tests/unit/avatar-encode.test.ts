import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_EDGE,
  centreSquare,
  clampSquare,
  moveSquare,
  resizeSquare,
} from '@/client/artwork/encode';

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

/**
 * The crop step: the centre is only where the square starts. Every move and every zoom the member
 * makes is a pure function of the previous square, and each is kept on the picture — the screen
 * measures a painted `<img>`, which is why the rule lives here rather than in the pointer handler.
 */
describe('the member moves and resizes the square, and it stays on the picture', () => {
  const wide = { width: 1600, height: 800 };

  it('moves by whole source pixels', () => {
    expect(moveSquare(wide.width, wide.height, centreSquare(1600, 800), -100, 0)).toEqual({
      x: 300,
      y: 0,
      size: 800,
    });
  });

  it('stops at the edge of the picture rather than reading past it', () => {
    const start = centreSquare(1600, 800);
    expect(moveSquare(wide.width, wide.height, start, -5000, -5000)).toEqual({
      x: 0,
      y: 0,
      size: 800,
    });
    expect(moveSquare(wide.width, wide.height, start, 5000, 5000)).toEqual({
      x: 800,
      y: 0,
      size: 800,
    });
  });

  it('resizes about its own centre, so what was under the middle stays there', () => {
    // Centre of the full-height square is (800, 400); a 400 square about it starts at (600, 200).
    expect(resizeSquare(wide.width, wide.height, centreSquare(1600, 800), 400)).toEqual({
      x: 600,
      y: 200,
      size: 400,
    });
  });

  it('cannot grow past the shorter edge, nor shrink to nothing', () => {
    expect(resizeSquare(wide.width, wide.height, centreSquare(1600, 800), 5000).size).toBe(800);
    expect(resizeSquare(wide.width, wide.height, centreSquare(1600, 800), 0).size).toBe(1);
  });

  it('slides back onto the picture when a resize at the edge would leave it', () => {
    // A 400 square in the top-left corner grown to 800 would start at (-200, -200).
    expect(resizeSquare(wide.width, wide.height, { x: 0, y: 0, size: 400 }, 800)).toEqual({
      x: 0,
      y: 0,
      size: 800,
    });
  });

  it('clamps a region from anywhere to whole pixels on the picture', () => {
    expect(clampSquare(1600, 800, { x: 1500.4, y: 10.6, size: 300.2 })).toEqual({
      x: 1300,
      y: 11,
      size: 300,
    });
  });
});
