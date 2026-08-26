import { describe, expect, it } from 'vitest';
import { ROLE } from '@thp/shared';
import type { InvitationRow } from '@thp/db';
import {
  describeInvitation,
  displayNameFor,
  invitationStatus,
} from '@/server/invitations/service';
import { INVITATION_LIFETIME_MS, invitationExpiryFrom } from '@/server/invitations/window';
import { generateToken, hashToken } from '@/server/auth/tokens';

/**
 * The parts of the invitation service that need no database: the derived status, the payload
 * shape, the window, and the token.
 *
 * Everything that touches a row is an integration question — see
 * packages/web/tests/integration/invitations.test.ts.
 */

const BASE: InvitationRow = {
  id: 'a4a1e6f0-0000-4000-8000-000000000001',
  email: 'invitee@example.test',
  role: ROLE.member,
  tokenHash: 'not-a-real-hash',
  invitedBy: 'a4a1e6f0-0000-4000-8000-000000000002',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  expiresAt: new Date('2026-08-08T00:00:00.000Z'),
  revokedAt: null,
  acceptedAt: null,
};

const DURING = new Date('2026-08-03T00:00:00.000Z');
const AFTER = new Date('2026-08-09T00:00:00.000Z');

describe('status is derived from the timestamps, never stored', () => {
  it('is pending inside the window with nothing set', () => {
    expect(invitationStatus(BASE, DURING)).toBe('pending');
  });

  it('is expired once the window has passed', () => {
    expect(invitationStatus(BASE, AFTER)).toBe('expired');
  });

  it('is expired exactly at the boundary, not pending', () => {
    // A window that includes its own end is a window somebody argues about.
    expect(invitationStatus(BASE, BASE.expiresAt)).toBe('expired');
  });

  it('is revoked whatever the clock says', () => {
    const revoked = { ...BASE, revokedAt: new Date('2026-08-02T00:00:00.000Z') };
    expect(invitationStatus(revoked, DURING)).toBe('revoked');
    expect(invitationStatus(revoked, AFTER)).toBe('revoked');
  });

  it('is accepted in preference to everything else', () => {
    const accepted = {
      ...BASE,
      revokedAt: new Date('2026-08-02T00:00:00.000Z'),
      acceptedAt: new Date('2026-08-02T00:00:00.000Z'),
    };
    expect(invitationStatus(accepted, AFTER)).toBe('accepted');
  });
});

describe('the payload an admin sees', () => {
  it('carries the fields the contract promises, as ISO strings', () => {
    const summary = describeInvitation(BASE, DURING);
    expect(summary.id).toBe(BASE.id);
    expect(summary.email).toBe(BASE.email);
    expect(summary.status).toBe('pending');
    expect(summary.expiresAt).toBe('2026-08-08T00:00:00.000Z');
    expect(summary.createdAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('carries no token, no hash and no inviter id under any key', () => {
    // Asserted over the serialised payload rather than by naming keys, so a field added later
    // cannot smuggle one in.
    const serialised = JSON.stringify(describeInvitation(BASE, DURING));
    expect(serialised).not.toContain(BASE.tokenHash);
    expect(serialised).not.toContain(BASE.invitedBy);
    expect(Object.keys(describeInvitation(BASE, DURING)).sort()).toEqual([
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'role',
      'status',
    ]);
  });
});

describe('the window', () => {
  it('is seven days', () => {
    // core-listening scope plan § Ticket 3 settles what docs/project/prd.md 3.1.4 leaves as "a fixed window".
    expect(INVITATION_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('is measured forward from the moment it is issued', () => {
    const now = new Date('2026-08-01T09:30:00.000Z');
    expect(invitationExpiryFrom(now).toISOString()).toBe('2026-08-08T09:30:00.000Z');
  });
});

describe('the token', () => {
  it('is unguessable, URL-safe and different every time', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashes to something that is not the token, deterministically', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
  });
});

describe('the display name an accepted account starts with', () => {
  it('is the local part, made presentable', () => {
    expect(displayNameFor('ada.lovelace@example.test')).toBe('Ada Lovelace');
    expect(displayNameFor('grace_hopper@example.test')).toBe('Grace Hopper');
    expect(displayNameFor('katherine-johnson@example.test')).toBe('Katherine Johnson');
    expect(displayNameFor('alan@example.test')).toBe('Alan');
  });

  it('never comes out empty, whatever the address looks like', () => {
    // `display_name` is NOT NULL, and an account with a blank name renders as a blank byline.
    for (const address of ['...@example.test', '@example.test', 'no-at-sign']) {
      expect(displayNameFor(address).length).toBeGreaterThan(0);
    }
  });
});
