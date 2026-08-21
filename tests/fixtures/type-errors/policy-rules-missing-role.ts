import type { PolicyRules } from '@/server/auth/policy';

/**
 * The negative control: a rules table that does not answer for every role. It must not compile.
 *
 * This is exactly the state every existing policy case would be in the moment `contributor` is
 * added to the role enum. The property being pinned is what makes
 * docs/epics/epic-core-listening/architecture.md § Extension points' "one enum value plus four widened cases" true:
 * the compiler names the cases, so nobody has to search for them and nobody can miss one.
 *
 * Nothing here suppresses the error — the guard test reads tsc's output for this filename.
 */
export const rules: PolicyRules = {
  'session.read': { roles: { admin: true, member: true } },
  'diagnostics.run': { roles: { admin: true, member: true } },
  'diagnostics.admin': { roles: { admin: true } },
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
