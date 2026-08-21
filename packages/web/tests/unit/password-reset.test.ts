import { describe, expect, it } from 'vitest';
import { PASSWORD_RESET_STATUSES, isPasswordResetStatus } from '@thp/shared';
import { passwordResetStatus } from '@/server/password-reset/service';
import {
  PASSWORD_RESET_LIFETIME_MS,
  PASSWORD_RESET_RESEND_INTERVAL_MS,
  isWithinResendInterval,
  passwordResetExpiryFrom,
} from '@/server/password-reset/window';
import { INVITATION_LIFETIME_MS } from '@/server/invitations/window';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function reset(overrides: {
  expiresAt?: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
}) {
  return {
    id: 'reset-1',
    userId: 'user-1',
    tokenHash: 'a-digest-not-a-token',
    createdAt: new Date(NOW.getTime() - 60_000),
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60_000),
    usedAt: overrides.usedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
  };
}

/**
 * Status is derived from three timestamps and never stored — the same rule `invitationStatus`
 * holds, and this file mirrors that one deliberately so the two flows cannot come to mean different
 * things by the same four words.
 */
describe('a reset’s status is read off its timestamps', () => {
  it('is pending while it is live', () => {
    expect(passwordResetStatus(reset({}), NOW)).toBe('pending');
  });

  it('is expired once the window has passed', () => {
    expect(passwordResetStatus(reset({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(
      'expired',
    );
    // The boundary is the moment itself, not the moment after it.
    expect(passwordResetStatus(reset({ expiresAt: NOW }), NOW)).toBe('expired');
  });

  it('is used once it has been completed, whatever the window says', () => {
    expect(
      passwordResetStatus(reset({ usedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) }), NOW),
    ).toBe('used');
  });

  it('is revoked when it was replaced, and used still wins over revoked', () => {
    expect(passwordResetStatus(reset({ revokedAt: NOW }), NOW)).toBe('revoked');
    // A reset that was completed and then swept by a later revocation is still a reset that
    // happened. "Used" is a fact about the account; "revoked" is a fact about the link.
    expect(passwordResetStatus(reset({ usedAt: NOW, revokedAt: NOW }), NOW)).toBe('used');
  });

  it('only ever answers one of the four named states', () => {
    for (const state of [
      passwordResetStatus(reset({}), NOW),
      passwordResetStatus(reset({ expiresAt: new Date(0) }), NOW),
      passwordResetStatus(reset({ usedAt: NOW }), NOW),
      passwordResetStatus(reset({ revokedAt: NOW }), NOW),
    ]) {
      expect(isPasswordResetStatus(state)).toBe(true);
      expect(PASSWORD_RESET_STATUSES).toContain(state);
    }
  });
});

describe('the reset window', () => {
  it('is one hour', () => {
    expect(PASSWORD_RESET_LIFETIME_MS).toBe(60 * 60 * 1000);
    expect(passwordResetExpiryFrom(NOW).getTime() - NOW.getTime()).toBe(
      PASSWORD_RESET_LIFETIME_MS,
    );
  });

  it('is far shorter than an invitation’s, because it is a key rather than an offer', () => {
    // Not a style point. An invitation is a standing offer to somebody with no account; a reset is
    // a live key to one that exists, and every extra hour is an hour a forwarded message stays
    // usable.
    expect(PASSWORD_RESET_LIFETIME_MS).toBeLessThan(INVITATION_LIFETIME_MS);
  });
});

describe('the re-send interval', () => {
  it('is sixty seconds', () => {
    expect(PASSWORD_RESET_RESEND_INTERVAL_MS).toBe(60 * 1000);
  });

  it('suppresses a second message inside it and permits one after it', () => {
    const justNow = new Date(NOW.getTime() - 1_000);
    const aWhileBack = new Date(NOW.getTime() - PASSWORD_RESET_RESEND_INTERVAL_MS - 1);

    expect(isWithinResendInterval(justNow, NOW)).toBe(true);
    expect(isWithinResendInterval(aWhileBack, NOW)).toBe(false);
    // The boundary itself is outside the interval — a request at exactly sixty seconds sends.
    expect(
      isWithinResendInterval(new Date(NOW.getTime() - PASSWORD_RESET_RESEND_INTERVAL_MS), NOW),
    ).toBe(false);
  });
});
