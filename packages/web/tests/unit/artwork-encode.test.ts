import { describe, expect, it } from 'vitest';
import { ARTWORK_MAX_EDGE, fitWithin } from '@/client/artwork/encode';

/**
 * **The size the browser reduces a chosen image to** (scope plan 1.4.1–1.4.3; scope prd 3.1.2).
 *
 * The decision is deliberately a pure function so this suite can exist at all — a canvas cannot be
 * driven from Node, and the encode around it is thin plumbing whose real property is *what lands in
 * the bucket*, which the browser suite asserts against the store rather than against a mock.
 *
 * What is pinned here is the rule the operator chose: **the aspect ratio survives.** Accepting any
 * image was picked over enforcing scope prd 5.3.2's square, so a landscape cover stays landscape
 * and the surfaces crop it — squaring it here would impose the shape by the back door.
 */

describe('an image larger than the bound is reduced, and stays the shape it was', () => {
  it('brings the longest edge down to 2000', () => {
    // The literal, not the module's own constant read back at itself.
    expect(ARTWORK_MAX_EDGE).toBe(2000);
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
  });

  it('preserves the source aspect ratio rather than squaring it', () => {
    expect(fitWithin(4000, 3000).width / fitWithin(4000, 3000).height).toBeCloseTo(4 / 3, 5);
    // Portrait is bounded on its *height*, which is what "longest edge" has to mean to be one rule.
    expect(fitWithin(3000, 4000)).toEqual({ width: 1500, height: 2000 });
    // A square stays square, and is bounded on both.
    expect(fitWithin(3000, 3000)).toEqual({ width: 2000, height: 2000 });
  });

  it('rounds to whole pixels without letting either edge reach zero', () => {
    // A panorama: the short edge rounds down below one pixel unless the floor is held at one.
    const wide = fitWithin(40_000, 3);
    expect(wide.width).toBe(2000);
    expect(wide.height).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(wide.width)).toBe(true);
    expect(Number.isInteger(wide.height)).toBe(true);
  });
});

describe('an image already inside the bound is left at its own size', () => {
  it('does not upscale a small cover', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(2000, 1500)).toEqual({ width: 2000, height: 1500 });
  });

  it('leaves one exactly at the bound alone', () => {
    expect(fitWithin(2000, 2000)).toEqual({ width: 2000, height: 2000 });
  });
});
