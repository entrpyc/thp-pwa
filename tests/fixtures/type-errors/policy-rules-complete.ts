import type { PolicyRules } from '@/server/auth/policy';

/**
 * The positive control for the exhaustiveness fixture: a rules table with an answer for every role
 * of every action compiles.
 *
 * It has to be kept in step with `POLICY_ACTIONS` by hand, and that is the point rather than a
 * chore — the day somebody adds an action and this fixture stops compiling is the day the property
 * being pinned ("a new role stops the build until every action answers for it") is demonstrated
 * working in the opposite direction too. Step 4 added five actions and the ownership flag, and this
 * file needing an edit for both is that mechanism doing its job.
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
};
