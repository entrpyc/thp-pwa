import type { PolicyRules } from '@/server/auth/policy';

/**
 * The positive control for the exhaustiveness fixture: a rules table with an answer for every role
 * of every action compiles.
 *
 * It has to be kept in step with `POLICY_ACTIONS` by hand, and that is the point rather than a
 * chore — the day somebody adds an action and this fixture stops compiling is the day the property
 * being pinned ("a new role stops the build until every action answers for it") is demonstrated
 * working in the opposite direction too. Ticket 4 added five actions and the ownership flag, and this
 * file needing an edit for both is that mechanism doing its job. Story 2 Ticket 01 adds the two
 * recording actions, and Ticket 04–05 the two pipeline actions. Story 3 adds eight — three for the
 * review gate, four for publication, and `recording.browse`, the first action in the product a
 * member may take over somebody else's content. Story 5 adds two — correcting a transcript, and
 * asking for a summary built on the correction. The notes scope adds two more — reading a
 * teaching's notes and writing one. The artwork scope adds `series.artwork` — setting a cover, split
 * from `series.update` for the reason every pair here is split. The same edit was required every
 * time.
 */
export const rules: PolicyRules = {
  'session.read': { roles: { admin: true, member: true } },
  'diagnostics.run': { roles: { admin: true, member: true } },
  'diagnostics.admin': { roles: { admin: true, member: false } },
  'invitation.issue': { roles: { admin: true, member: false } },
  'invitation.list': { roles: { admin: true, member: false } },
  'invitation.revoke': { roles: { admin: true, member: false } },
  'invitation.resend': { roles: { admin: true, member: false } },
  'account.list': { roles: { admin: true, member: false } },
  'account.deactivate': { roles: { admin: true, member: false } },
  'account.reactivate': { roles: { admin: true, member: false } },
  'role.assign': { roles: { admin: true, member: false } },
  'profile.update': { roles: { admin: true, member: true }, requiresOwnership: true },
  'recording.upload': { roles: { admin: true, member: false } },
  'recording.list': { roles: { admin: true, member: false } },
  'recording.edit': { roles: { admin: true, member: false } },
  'pipeline.read': { roles: { admin: true, member: false } },
  'pipeline.rerun': { roles: { admin: true, member: false } },
  'review.list': { roles: { admin: true, member: false } },
  'review.resolve': { roles: { admin: true, member: false } },
  'review.regenerate': { roles: { admin: true, member: false } },
  'recording.publish': { roles: { admin: true, member: false } },
  'recording.unpublish': { roles: { admin: true, member: false } },
  'summary.edit': { roles: { admin: true, member: false } },
  'summary.unpublish': { roles: { admin: true, member: false } },
  'recording.browse': { roles: { admin: true, member: true } },
  'transcript.correct': { roles: { admin: true, member: false } },
  'summary.regenerate': { roles: { admin: true, member: false } },
  'series.create': { roles: { admin: true, member: false } },
  'series.update': { roles: { admin: true, member: false } },
  'series.assign': { roles: { admin: true, member: false } },
  'series.list': { roles: { admin: true, member: false } },
  'series.browse': { roles: { admin: true, member: true } },
  'series.artwork': { roles: { admin: true, member: false } },
  'note.read': { roles: { admin: true, member: true } },
  'note.write': { roles: { admin: true, member: true } },
  'note.edit': { roles: { admin: true, member: true }, requiresOwnership: true },
  'note.delete': { roles: { admin: true, member: true }, requiresOwnership: true },
  'note.moderate': { roles: { admin: true, member: false } },
  'note.react': { roles: { admin: true, member: true } },
  'note.pin': { roles: { admin: true, member: false } },
  'note.unpin': { roles: { admin: true, member: false } },
  'chapter.edit': { roles: { admin: true, member: false } },
};
