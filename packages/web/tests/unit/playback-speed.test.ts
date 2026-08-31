import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEEDS,
  formatPlaybackSpeed,
  isPlaybackSpeed,
  nextPlaybackSpeed,
} from '@thp/shared';

/**
 * **The steps** ([3.2.4](docs/project/prd.md)), asserted where they are declared.
 *
 * One tuple is read by the control that renders them, the route that refuses anything else and the
 * check constraint on `user.preferred_playback_speed` — so this suite is not about a list, it is
 * about the list all three of those read.
 */

describe('the speed control offers exactly the steps the tuple names', () => {
  it('is the set the requirement names, in the order a control cycles them', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });

  it('starts every account at normal speed', () => {
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1);
    expect(isPlaybackSpeed(DEFAULT_PLAYBACK_SPEED)).toBe(true);
  });
});

describe('a value outside the tuple is not a playback speed', () => {
  it.each([0, 0.6, 1.1, 3, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (value) => {
    expect(isPlaybackSpeed(value)).toBe(false);
  });

  it('refuses a number that arrived as a string, and anything that is not a number', () => {
    // This is what the API's parse leans on: a request body is `unknown` until something answers
    // for it, and the column must not be reachable by a caller that is not the player.
    expect(isPlaybackSpeed('1.5')).toBe(false);
    expect(isPlaybackSpeed(null)).toBe(false);
    expect(isPlaybackSpeed(undefined)).toBe(false);
    expect(isPlaybackSpeed({})).toBe(false);
  });

  it('accepts every one of them', () => {
    for (const speed of PLAYBACK_SPEEDS) expect(isPlaybackSpeed(speed)).toBe(true);
  });
});

describe('the control is one pill that cycles', () => {
  it('advances a step and wraps at the top', () => {
    expect(nextPlaybackSpeed(0.5)).toBe(0.75);
    expect(nextPlaybackSpeed(1)).toBe(1.25);
    expect(nextPlaybackSpeed(1.5)).toBe(1.75);
    expect(nextPlaybackSpeed(2)).toBe(0.5);
  });

  it('returns to where it started after one press per step, so every step is reachable', () => {
    let speed: number = DEFAULT_PLAYBACK_SPEED;
    const seen = new Set<number>();
    for (let press = 0; press < PLAYBACK_SPEEDS.length; press += 1) {
      speed = nextPlaybackSpeed(speed);
      seen.add(speed);
    }
    expect(speed).toBe(DEFAULT_PLAYBACK_SPEED);
    expect([...seen].sort((a, b) => a - b)).toEqual([...PLAYBACK_SPEEDS]);
  });

  it('recovers to the first step from a value no control could have produced', () => {
    expect(nextPlaybackSpeed(1.1)).toBe(0.5);
  });
});

describe('the pill prints the rate the way the reference does', () => {
  it('drops trailing zeros', () => {
    expect(formatPlaybackSpeed(1)).toBe('1x');
    expect(formatPlaybackSpeed(1.5)).toBe('1.5x');
    expect(formatPlaybackSpeed(0.75)).toBe('0.75x');
  });
});
