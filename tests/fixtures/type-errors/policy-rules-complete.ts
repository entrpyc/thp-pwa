import type { PolicyRules } from '@/server/auth/policy';

/**
 * The positive control for the exhaustiveness fixture: a rules table with an answer for every role
 * of every action compiles.
 *
 * It has to be kept in step with `POLICY_ACTIONS` by hand, and that is the point rather than a
 * chore — the day somebody adds an action and this fixture stops compiling is the day the property
 * being pinned ("a new role stops the build until every action answers for it") is demonstrated
 * working in the opposite direction too.
 */
export const rules: PolicyRules = {
  'session.read': { admin: true, member: true },
  'diagnostics.run': { admin: true, member: true },
  'diagnostics.admin': { admin: true, member: false },
  'invitation.issue': { admin: true, member: false },
  'invitation.list': { admin: true, member: false },
  'invitation.revoke': { admin: true, member: false },
  'invitation.resend': { admin: true, member: false },
};
