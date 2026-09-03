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
    avatarKey: null,
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

  /**
   * 1.4.7 — resolving a review item is admin-only, and it is *this* module that says so rather
   * than the panel that renders the button. Scripture adds a kind rather than a route, so the
   * decision it goes through is the one that already existed — which is what makes it worth
   * pinning here rather than assuming.
   */
  it('lets an admin act on a review item and refuses a member every review action', () => {
    for (const action of ['review.list', 'review.resolve', 'review.regenerate'] as const) {
      expect(can(actorWith(ROLE.admin), action), action).toBe(true);
      expect(can(actorWith(ROLE.member), action), action).toBe(false);
      expect(can(null, action), action).toBe(false);
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
      avatarKey: 'avatars/private-object-name.webp',
    };

    const actor = toActor(row);
    expect(actor).toEqual({
      id: 'u1',
      email: 'person@example.test',
      displayName: 'Person',
      role: ROLE.member,
      preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
      avatarKey: 'avatars/private-object-name.webp',
    });

    const payload = describeActor(actor);
    // Everything but the key: the actor carries it so the accounts module can sign a URL for it,
    // and the payload is the boundary at which it stops travelling.
    const { avatarKey: _withheld, ...identity } = actor;
    expect(payload).toEqual(identity);
    expect(JSON.stringify(payload)).not.toContain('private-object-name');
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
    avatarKey: null,
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

/**
 * **The two note actions** (Tasks 1.4 and 1.5) — active-scope prd 3.1.12 and 3.7's matrix.
 *
 * The property being pinned is the unusual one for this table: these are the first actions in the
 * product where **both roles answer identically and are meant to**. Nothing about writing a note
 * differs by role, and nothing about reading one does either — what a member sees through
 * `note.read` is decided by the query condition in `packages/db/src/notes.ts`, never here.
 */
describe('the two note actions are in the table, and neither differs by role', () => {
  it.each(['note.read', 'note.write'] as const)('permits %s for both roles', (action) => {
    expect(can(actorWith(ROLE.admin), action)).toBe(true);
    expect(can(actorWith(ROLE.member), action)).toBe(true);
  });

  it('answers them from the rules table rather than from a call site', () => {
    expect(isPolicyAction('note.read')).toBe(true);
    expect(isPolicyAction('note.write')).toBe(true);
    // Names nobody wrote a rule for stay denied for both roles, which is what makes adding an
    // action a visible edit rather than something a coarse rule quietly already covered.
    for (const role of ROLES) {
      for (const absent of ['note.list', 'note.report', 'note.own', 'note.use']) {
        expect(can(actorWith(role), absent), `${absent}/${role}`).toBe(false);
      }
    }
  });

  it('refuses them to an anonymous caller', () => {
    expect(can(null, 'note.read')).toBe(false);
    expect(can(null, 'note.write')).toBe(false);
  });
});

/**
 * **The six the rest of the scope adds** — active-scope architecture § 8's table, asserted against
 * the policy module alone with no route and no request involved.
 *
 * The claim being pinned is never "the route refuses". It is that **the refusal comes from `can`
 * reading the rule**, which is what makes every one of these a row in a table an operator can read
 * rather than a comparison buried in a handler.
 */
describe('the six moderation, ownership and reaction actions', () => {
  const owner: Actor = {
    id: 'owner-1',
    email: 'owner@example.test',
    displayName: 'Owner',
    role: ROLE.member,
    preferredPlaybackSpeed: DEFAULT_PLAYBACK_SPEED,
    avatarKey: null,
  };
  const somebodyElse: Actor = { ...owner, id: 'other-1', email: 'other@example.test' };
  const admin: Actor = { ...owner, id: 'admin-1', email: 'admin@example.test', role: ROLE.admin };

  const noteOf = (authorId: string) => ({ kind: 'note', id: 'note-1', ownerId: authorId });

  it('has all six in the table, so each is a rule rather than a call-site check', () => {
    for (const action of [
      'note.edit',
      'note.delete',
      'note.moderate',
      'note.react',
      'note.pin',
      'note.unpin',
    ]) {
      expect(isPolicyAction(action), action).toBe(true);
      expect(can(null, action), action).toBe(false);
    }
  });

  // 5.1.2 and 5.2.2 — owned, and owned *against an admin too*.
  it.each(['note.edit', 'note.delete'] as const)(
    'permits %s on your own note and refuses it on another member’s',
    (action) => {
      expect(can(owner, action, noteOf(owner.id))).toBe(true);
      expect(can(owner, action, noteOf(somebodyElse.id))).toBe(false);
    },
  );

  it('refuses an admin an edit of a note they did not write — moderation is not rewriting', () => {
    // 3.6.2, and the whole reason `note.edit` carries `requiresOwnership` rather than being
    // widened to admin: an admin may take a note down and may not put words in somebody's mouth.
    expect(can(admin, 'note.edit', noteOf(owner.id))).toBe(false);
    expect(can(admin, 'note.edit', noteOf(admin.id))).toBe(true);
  });

  it('refuses both owned actions asked with no resource at all', () => {
    // "Permitted on your own" must not collapse into "permitted" when nobody says whose — which is
    // exactly what an owned action asked in the abstract would mean.
    for (const action of ['note.edit', 'note.delete'] as const) {
      expect(can(owner, action), action).toBe(false);
      expect(can(admin, action), action).toBe(false);
      expect(can(owner, action, { kind: 'note' }), action).toBe(false);
    }
  });

  // 6.1.2 — the fall-through `DELETE /notes/{id}` takes when the owned answer is no.
  it('grants note.moderate to an admin alone, whatever note is named', () => {
    expect(can(admin, 'note.moderate')).toBe(true);
    expect(can(owner, 'note.moderate')).toBe(false);
    // Not owned: handing it somebody else's note must not change the answer in either direction.
    expect(can(admin, 'note.moderate', noteOf(owner.id))).toBe(true);
    expect(can(owner, 'note.moderate', noteOf(owner.id))).toBe(false);
  });

  it('is answered for a member by note.delete and then by note.moderate, and both say no', () => {
    // The two questions the delete route asks, in order, for a member acting on somebody else's
    // note. Both denying is what makes that route's refusal come from the table twice over.
    expect(can(somebodyElse, 'note.delete', noteOf(owner.id))).toBe(false);
    expect(can(somebodyElse, 'note.moderate')).toBe(false);
    // And for an admin: the first denies, the second permits — which is also the audit condition.
    expect(can(admin, 'note.delete', noteOf(owner.id))).toBe(false);
    expect(can(admin, 'note.moderate')).toBe(true);
    // An admin on their **own** note satisfies the first, so moderation is never reached (6.1.4).
    expect(can(admin, 'note.delete', noteOf(admin.id))).toBe(true);
  });

  // 4.2.3 — both roles, and not owned: reacting to your own note and to somebody else's are one
  // question, because the requirement grants the reaction to any public note.
  it('grants note.react to both roles without asking whose note it is', () => {
    for (const role of ROLES) {
      expect(can(actorWith(role), 'note.react'), role).toBe(true);
    }
    expect(can(somebodyElse, 'note.react', noteOf(owner.id))).toBe(true);
    expect(can(owner, 'note.react', noteOf(owner.id))).toBe(true);
  });

  // 6.2.4 and 6.3.2 — two actions, both admin-only, following the publish/unpublish split.
  it.each(['note.pin', 'note.unpin'] as const)('grants %s to an admin alone', (action) => {
    expect(can(admin, action)).toBe(true);
    expect(can(owner, action)).toBe(false);
  });

  it('keeps pin and unpin as separate entries rather than one aliased to the other', () => {
    // The split is only worth having if it exists to be widened — one action answering for both
    // would pass every assertion above and be a single rule wearing two names.
    expect(isPolicyAction('note.pin')).toBe(true);
    expect(isPolicyAction('note.unpin')).toBe(true);
    expect(POLICY_ACTIONS.filter((one) => one === 'note.pin' || one === 'note.unpin')).toEqual([
      'note.pin',
      'note.unpin',
    ]);
  });
});

/**
 * 4.1.4 — **the member's scripture read goes through the decision that already existed.**
 *
 * References ride the recording's publication (scope prd 3.2.13), so reading them
 * is `recording.browse` asked again rather than a second action with a second set of rules. The
 * assertion worth having is therefore the *absence* of a scripture action: a route that invented
 * one would still refuse an anonymous caller and still permit a member, and would have quietly
 * given the product two answers to "who may read what a teaching cites".
 */
describe('reading a teaching’s scripture is the recording’s own authorisation question', () => {
  it('adds no scripture action of its own to the policy table', () => {
    expect(POLICY_ACTIONS.filter((one) => one.startsWith('scripture.'))).toEqual([]);
    expect(isPolicyAction('scripture.read')).toBe(false);
    expect(can(actorWith(ROLE.admin), 'scripture.read')).toBe(false);
  });

  it('answers recording.browse for both roles and refuses an anonymous caller', () => {
    for (const role of ROLES) {
      expect(can(actorWith(role), 'recording.browse'), role).toBe(true);
    }
    expect(can(null, 'recording.browse')).toBe(false);
  });
});

describe('setting a series cover is its own action, not more of series.update', () => {
  it('permits series.artwork for an admin and refuses it for a member', () => {
    // scope plan 1.2.10, and scope prd 3.1.8: the refusal is the API's. Admin-only in this scope
    // because the Contributor role does not exist in the enum yet (scope tdd 1.5).
    expect(can(actorWith(ROLE.admin), 'series.artwork')).toBe(true);
    expect(can(actorWith(ROLE.member), 'series.artwork')).toBe(false);
  });

  it('is a real action in the table, distinct from the three series actions already there', () => {
    // Distinct rather than a widening: the day a Contributor may set a cover without being able to
    // rename the study, this split stops being decoration.
    expect(isPolicyAction('series.artwork')).toBe(true);
    expect(POLICY_ACTIONS.filter((action) => action === 'series.artwork')).toHaveLength(1);
    for (const other of ['series.create', 'series.update', 'series.assign'] as const) {
      expect(other).not.toBe('series.artwork');
      expect(isPolicyAction(other)).toBe(true);
    }
    // And the nearby names nobody wrote a rule for are still denied, for both roles.
    for (const role of ROLES) {
      expect(can(actorWith(role), 'series.artwork.delete'), role).toBe(false);
      expect(can(actorWith(role), 'artwork.upload'), role).toBe(false);
    }
  });

  it('refuses it to an anonymous caller', () => {
    expect(can(null, 'series.artwork')).toBe(false);
  });
});

/**
 * 3.2.16 — **correcting a title is its own action, and deliberately not one of the three it sits
 * between.**
 *
 * The assertion worth having is the separation rather than the permission: `recording.edit` passes
 * every check below identically to `recording.upload`, `recording.publish` and `recording.list`,
 * because all four are admin-only today. What a test can pin is that there are *four* entries — the
 * day a Contributor may fix a misheard title without being able to add a teaching or take one live,
 * a widened `recording.upload` would have quietly given all three away together.
 */
describe('correcting a recording’s title and date is its own action', () => {
  it('permits recording.edit for an admin and refuses it for a member', () => {
    expect(can(actorWith(ROLE.admin), 'recording.edit')).toBe(true);
    expect(can(actorWith(ROLE.member), 'recording.edit')).toBe(false);
    expect(can(null, 'recording.edit')).toBe(false);
  });

  it('is a real entry in the table, distinct from upload, publish and list', () => {
    expect(isPolicyAction('recording.edit')).toBe(true);
    expect(POLICY_ACTIONS.filter((action) => action === 'recording.edit')).toHaveLength(1);
    for (const other of ['recording.upload', 'recording.list', 'recording.publish'] as const) {
      expect(other).not.toBe('recording.edit');
      expect(isPolicyAction(other)).toBe(true);
    }
  });

  it('is not owned — an admin edits any recording, not only ones they uploaded', () => {
    // Every other "may I write this" in the product that is owned says so with `requiresOwnership`.
    // A recording has no owner column at all, and an admin correcting a colleague's typo is the
    // ordinary case rather than an exception.
    expect(
      can(actorWith(ROLE.admin), 'recording.edit', {
        kind: 'recording',
        id: 'r1',
        ownerId: 'somebody-else',
      }),
    ).toBe(true);
  });

  it('grants nothing to the nearby names nobody wrote a rule for', () => {
    for (const role of ROLES) {
      expect(can(actorWith(role), 'recording.rename'), role).toBe(false);
      expect(can(actorWith(role), 'recording.update'), role).toBe(false);
      expect(can(actorWith(role), 'recording.delete'), role).toBe(false);
    }
  });
});
