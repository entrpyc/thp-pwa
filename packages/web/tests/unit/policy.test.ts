import { describe, expect, it } from 'vitest';
import { ROLE, ROLES } from '@thp/shared';
import {
  POLICY_ACTIONS,
  can,
  describeActor,
  isPolicyAction,
  toActor,
  type Actor,
} from '@/server/auth/policy';

function actorWith(role: (typeof ROLES)[number]): Actor {
  return { id: 'actor-1', email: 'a@example.test', displayName: 'A', role };
}

describe('the policy module answers (actor, action, resource)', () => {
  it('denies an unknown action rather than throwing or permitting', () => {
    expect(() => can(actorWith(ROLE.admin), 'no.such.action')).not.toThrow();
    expect(can(actorWith(ROLE.admin), 'no.such.action')).toBe(false);
    expect(can(actorWith(ROLE.member), 'no.such.action')).toBe(false);
    expect(isPolicyAction('no.such.action')).toBe(false);
  });

  it('denies an anonymous caller every action there is', () => {
    for (const action of POLICY_ACTIONS) {
      expect(can(null, action), action).toBe(false);
    }
  });

  it('permits the admin-only action for an admin and refuses it for a member', () => {
    expect(can(actorWith(ROLE.admin), 'diagnostics.admin')).toBe(true);
    expect(can(actorWith(ROLE.member), 'diagnostics.admin')).toBe(false);
  });

  it('permits both roles the actions both roles have', () => {
    for (const role of ROLES) {
      expect(can(actorWith(role), 'session.read'), role).toBe(true);
      expect(can(actorWith(role), 'diagnostics.run'), role).toBe(true);
    }
  });

  it('has an answer for every role for every action', () => {
    // The compiler already requires this; asserting it stops a future `as` cast from hiding a gap.
    for (const action of POLICY_ACTIONS) {
      for (const role of ROLES) {
        expect(typeof can(actorWith(role), action), `${action}/${role}`).toBe('boolean');
      }
    }
  });

  it('turns a row into an actor and an actor into the payload the client renders from', () => {
    const row = {
      id: 'u1',
      email: 'person@example.test',
      passwordHash: 'argon2-hash-goes-here',
      displayName: 'Person',
      role: ROLE.member,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const actor = toActor(row);
    expect(actor).toEqual({
      id: 'u1',
      email: 'person@example.test',
      displayName: 'Person',
      role: ROLE.member,
    });

    const payload = describeActor(actor);
    expect(payload).toEqual(actor);
    // The hash must not survive the trip, however the payload is built.
    expect(JSON.stringify(payload)).not.toContain('argon2-hash-goes-here');
  });
});
