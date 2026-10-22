import { describe, expect, it } from 'vitest';
import { ARTWORK_OUTPUT_TYPE } from '@/client/artwork/encode';
import { SKIP_STEP_MS, mediaMetadataFor, positionStateFor } from '@/client/playback/media-session';

/**
 * **What the device is told** ([3.2.6](docs/project/prd.md)), asserted over strings and numbers
 * with no browser in the room.
 *
 * The two decisions are pure for exactly this reason. What a lock screen *draws* can only be
 * checked on a phone — the operator's device steps do that — but what it is *told* is a function
 * of the teaching and of three readings off the element, and a wrong answer there is a lock screen
 * that names nothing, or a `setPositionState` that throws four times a second. The browser suite
 * checks the wiring that reads the element and makes the calls.
 */

const COVER = 'https://store.test/artwork/fruit.webp?X-Amz-Signature=abc';

describe('what the lock screen names', () => {
  it('names the teaching, its series as the artist, and the series` cover', () => {
    expect(
      mediaMetadataFor({ title: 'On patience', seriesTitle: 'Fruit of the Spirit', artworkUrl: COVER }),
    ).toEqual({
      title: 'On patience',
      artist: 'Fruit of the Spirit',
      artwork: [{ src: COVER, type: ARTWORK_OUTPUT_TYPE }],
    });
  });

  it('names a teaching in no series by its title alone', () => {
    // No artist and no artwork rather than a placeholder — the answer every other surface gives a
    // teaching that belongs to no series (3.2.15).
    const metadata = mediaMetadataFor({ title: 'A standalone word', seriesTitle: null, artworkUrl: null });
    expect(metadata).toEqual({ title: 'A standalone word', artwork: [] });
    expect('artist' in metadata).toBe(false);
  });

  it('keeps the series` name on a teaching whose series has no cover', () => {
    const metadata = mediaMetadataFor({ title: 'Week one', seriesTitle: 'Autumn study', artworkUrl: null });
    expect(metadata.artist).toBe('Autumn study');
    expect(metadata.artwork).toEqual([]);
  });

  it('declares the cover as WebP, because that is the one format a cover is ever stored in', () => {
    expect(ARTWORK_OUTPUT_TYPE).toBe('image/webp');
  });
});

describe('when a position is true enough to declare', () => {
  it('passes a reading from a playing element through', () => {
    expect(
      positionStateFor({ durationSeconds: 5400, positionSeconds: 1234.5, playbackRate: 1.25 }),
    ).toEqual({ duration: 5400, position: 1234.5, playbackRate: 1.25 });
  });

  it('declares nothing before metadata, after the source is dropped, or for a stream', () => {
    // `NaN` is what the element reports for `duration` in the first two states and `Infinity` in
    // the third; the platform throws on all of them.
    expect(positionStateFor({ durationSeconds: NaN, positionSeconds: 0, playbackRate: 1 })).toBeNull();
    expect(
      positionStateFor({ durationSeconds: Infinity, positionSeconds: 10, playbackRate: 1 }),
    ).toBeNull();
    expect(positionStateFor({ durationSeconds: -1, positionSeconds: 0, playbackRate: 1 })).toBeNull();
  });

  it('clamps a position the element reports a hair outside the teaching', () => {
    // At the very end `currentTime` can read fractionally past `duration`; a position past the
    // duration is one the platform refuses, so it is declared as the end.
    expect(
      positionStateFor({ durationSeconds: 120, positionSeconds: 120.04, playbackRate: 1 }),
    ).toEqual({ duration: 120, position: 120, playbackRate: 1 });
    expect(
      positionStateFor({ durationSeconds: 120, positionSeconds: -0.001, playbackRate: 1 }),
    ).toEqual({ duration: 120, position: 0, playbackRate: 1 });
  });

  it('declares nothing at a rate the device cannot extrapolate from', () => {
    expect(positionStateFor({ durationSeconds: 120, positionSeconds: 10, playbackRate: 0 })).toBeNull();
    expect(positionStateFor({ durationSeconds: 120, positionSeconds: 10, playbackRate: NaN })).toBeNull();
  });

  it('declares nothing for a position that is not a number', () => {
    expect(positionStateFor({ durationSeconds: 120, positionSeconds: NaN, playbackRate: 1 })).toBeNull();
  });

  it('is the element`s rate, not a normalised one, so 2× shows a clock that moves at 2×', () => {
    expect(
      positionStateFor({ durationSeconds: 120, positionSeconds: 10, playbackRate: 2 })?.playbackRate,
    ).toBe(2);
  });
});

describe('the lock screen`s step is the bar`s', () => {
  it('is ten seconds (3.2.9)', () => {
    // Stated as a number because the transport's own controls say `10_000` in place, and the whole
    // point is that a member finds the two surfaces move by the same amount.
    expect(SKIP_STEP_MS).toBe(10_000);
  });
});
