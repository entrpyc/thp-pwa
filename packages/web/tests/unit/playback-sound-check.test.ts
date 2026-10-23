import { describe, expect, it } from 'vitest';
import { SOUND_CHECK_MS, soundRemedy } from '@/client/playback/stall';

/**
 * **A press for sound that produced no sound** ([3.2.6](docs/project/prd.md)), decided over five
 * readings with no browser in the room.
 *
 * The ticket is a headset press with the phone locked: the element says "playing", the lock screen
 * and the bar draw it, and nothing is heard until the member pauses and plays again by hand. What
 * a real WebView does on a resume from the lock screen can only be seen on a phone; what the player
 * does with the clock it reads afterwards is a function, and this is its table.
 */

const press = { paused: false, wantsPlay: true, startedAtSeconds: 120, remedies: 0 };

describe('the check that a press for sound produced sound', () => {
  it('is satisfied by a clock that has moved', () => {
    expect(soundRemedy({ ...press, nowSeconds: 120.25 })).toBe('none');
    expect(soundRemedy({ ...press, nowSeconds: 121.5 })).toBe('none');
  });

  it('pauses and plays again — the member`s own remedy — when the clock stood still', () => {
    expect(soundRemedy({ ...press, nowSeconds: 120 })).toBe('replay');
    // A hair's movement is a timer artefact, not sound.
    expect(soundRemedy({ ...press, nowSeconds: 120.02 })).toBe('replay');
  });

  it('reloads the source once a replay has not taken, and then leaves it', () => {
    expect(soundRemedy({ ...press, nowSeconds: 120, remedies: 1 })).toBe('reload');
    expect(soundRemedy({ ...press, nowSeconds: 120, remedies: 2 })).toBe('leave');
    expect(soundRemedy({ ...press, nowSeconds: 120, remedies: 7 })).toBe('leave');
  });

  it('does nothing once the member has asked for silence, whatever the clock reads', () => {
    // The element paused since the press — by the member, or by the replay's own pause.
    expect(soundRemedy({ ...press, paused: true, nowSeconds: 120 })).toBe('none');
    // The press for silence arrived before the element caught up with it.
    expect(soundRemedy({ ...press, wantsPlay: false, nowSeconds: 120 })).toBe('none');
  });

  it('checks soon enough that a member is not left in silence wondering', () => {
    expect(SOUND_CHECK_MS).toBeLessThanOrEqual(3_000);
    expect(SOUND_CHECK_MS).toBeGreaterThanOrEqual(1_000);
  });
});
