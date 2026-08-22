import { describe, expect, it } from 'vitest';
import { GRANT_RENEWAL_MARGIN_MS, shouldRenewGrant } from '@/client/playback/renewal';

/**
 * **When a playback grant is replaced**, asserted against two numbers rather than a clock.
 *
 * The decision is deliberately a pure function so this suite can exist at all: a timer-driven
 * renewal could only be tested by waiting an hour, or by faking time — and a fake clock proves the
 * fake, not the rule. What the browser suite asserts is the *behaviour* on the other side of this
 * decision: that position and play state survive the swap.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('a grant is left alone while it has time on it', () => {
  it('says no to one minted a moment ago', () => {
    expect(shouldRenewGrant({ expiresAt: at(HOUR), now: NOW })).toBe(false);
  });

  it('says no just outside the margin', () => {
    expect(shouldRenewGrant({ expiresAt: at(GRANT_RENEWAL_MARGIN_MS + 1000), now: NOW })).toBe(
      false,
    );
  });
});

describe('a grant is replaced before it dies, not after', () => {
  it('says yes at the margin, and inside it', () => {
    // The whole point of the margin: renewal starts while the current URL still works, so the
    // member never hears the gap that waiting for an error would cost.
    expect(shouldRenewGrant({ expiresAt: at(GRANT_RENEWAL_MARGIN_MS), now: NOW })).toBe(true);
    expect(shouldRenewGrant({ expiresAt: at(60_000), now: NOW })).toBe(true);
  });

  it('says yes to one that has already expired', () => {
    expect(shouldRenewGrant({ expiresAt: at(-1000), now: NOW })).toBe(true);
  });

  it('says yes to an expiry it cannot read', () => {
    // A grant whose expiry cannot be parsed is a grant that cannot be trusted. Re-requesting one
    // costs a request; trusting it costs the listen.
    expect(shouldRenewGrant({ expiresAt: 'not a date', now: NOW })).toBe(true);
    expect(shouldRenewGrant({ expiresAt: '', now: NOW })).toBe(true);
  });
});

describe('the margin is five minutes', () => {
  it('is long enough for a slow renewal and short enough to be most of an hour in', () => {
    // Stated as a number rather than left to the comment beside it, because the whole renewal
    // design rests on this being comfortably smaller than the grant's one hour.
    expect(GRANT_RENEWAL_MARGIN_MS).toBe(5 * 60 * 1000);
    expect(GRANT_RENEWAL_MARGIN_MS).toBeLessThan(HOUR / 2);
  });
});
