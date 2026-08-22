import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYBACK_SPEED, ROLE, ROLES } from '@thp/shared';
import {
  POLICY_ACTIONS,
  can,
  describeActor,
  isPolicyAction,
  toActor,
  type Actor,
} from '@/server/auth/policy';

function actorWith(role: (typeof ROLES)[number]): Actor {
  return {
    id: 'actor-1',
    email: 'a@example.test',
    displayName: 'A',
    role,
    preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
  };
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
      deactivatedAt: null,
      preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
    };

    const actor = toActor(row);
    expect(actor).toEqual({
      id: 'u1',
      email: 'person@example.test',
      displayName: 'Person',
      role: ROLE.member,
      preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
    });

    const payload = describeActor(actor);
    expect(payload).toEqual(actor);
    // The hash must not survive the trip, however the payload is built.
    expect(JSON.stringify(payload)).not.toContain('argon2-hash-goes-here');
  });
});

/**
 * Ticket 4's addition: the resource parameter, which ticket 2 shipped and nothing read until now.
 *
 * These assertions are deliberately made against the policy module alone, with no route and no
 * request involved. The claim being pinned is not "the profile route refuses" — it is that the
 * *refusal comes from `can` reading the resource*, which is what makes every later owned thing (a
 * note, a highlight, a progress row) one row in the rules table rather than an id comparison in a
 * handler.
 */
describe('an owned action is answered against the resource, not only the role', () => {
  const owner: Actor = {
    id: 'owner-1',
    email: 'owner@example.test',
    displayName: 'Owner',
    role: ROLE.member,
    preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
  };
  const somebodyElse: Actor = { ...owner, id: 'other-1', email: 'other@example.test' };
  const admin: Actor = { ...owner, id: 'admin-1', email: 'admin@example.test', role: ROLE.admin };

  const profileOf = (actorId: string) => ({ kind: 'profile', id: actorId, ownerId: actorId });

  it('permits the same (actor, action) on their own resource and refuses it on another’s', () => {
    expect(can(owner, 'profile.update', profileOf(owner.id))).toBe(true);
    expect(can(owner, 'profile.update', profileOf(somebodyElse.id))).toBe(false);
  });

  it('refuses an admin the same way it refuses a member — a name is not an operator control', () => {
    expect(can(admin, 'profile.update', profileOf(admin.id))).toBe(true);
    expect(can(admin, 'profile.update', profileOf(owner.id))).toBe(false);
  });

  it('refuses an owned action asked with no resource at all', () => {
    // "Permitted on your own" must not collapse into "permitted" when nobody says whose.
    expect(can(owner, 'profile.update')).toBe(false);
    expect(can(admin, 'profile.update')).toBe(false);
    expect(can(owner, 'profile.update', { kind: 'profile' })).toBe(false);
  });

  it('ignores the resource for the actions that are not owned', () => {
    // A role-only action must not become answerable by handing it somebody else's resource.
    expect(can(admin, 'account.deactivate', profileOf(owner.id))).toBe(true);
    expect(can(owner, 'account.deactivate', profileOf(owner.id))).toBe(false);
  });
});

describe('the two Story 5 actions are in the table, denied by default and per role', () => {
  it.each(['transcript.correct', 'summary.regenerate'] as const)(
    'permits %s for an admin and refuses it for a member',
    (action) => {
      expect(can(actorWith(ROLE.admin), action)).toBe(true);
      expect(can(actorWith(ROLE.member), action)).toBe(false);
    },
  );

  it('answers them from the rules table rather than from a call site', () => {
    // Both are real actions the module knows, which is what makes "added to the table" a fact
    // rather than a claim — an action checked at a call site would not be in this list at all.
    expect(isPolicyAction('transcript.correct')).toBe(true);
    expect(isPolicyAction('summary.regenerate')).toBe(true);
    // And the nearby names nobody wrote a rule for are still denied, for both roles.
    for (const role of ROLES) {
      expect(can(actorWith(role), 'transcript.read'), role).toBe(false);
      expect(can(actorWith(role), 'transcript.delete'), role).toBe(false);
      expect(can(actorWith(role), 'summary.generate'), role).toBe(false);
    }
  });

  it('refuses them to an anonymous caller', () => {
    expect(can(null, 'transcript.correct')).toBe(false);
    expect(can(null, 'summary.regenerate')).toBe(false);
  });
});

describe('the admin account actions are the API’s refusal, not the console’s', () => {
  it.each([
    'account.list',
    'account.deactivate',
    'account.reactivate',
    'role.assign',
  ] as const)('permits %s for an admin and refuses it for a member', (action) => {
    expect(can(actorWith(ROLE.admin), action)).toBe(true);
    expect(can(actorWith(ROLE.member), action)).toBe(false);
  });
});
