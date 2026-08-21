import type { PolicyRules } from '@/server/auth/policy';

/**
 * The negative control: a rules table that does not answer for every role. It must not compile.
 *
 * This is exactly the state every existing policy case would be in the moment `contributor` is
 * added to the role enum. The property being pinned is what makes
 * docs/slice-architecture.md § Extension points' "one enum value plus four widened cases" true:
 * the compiler names the four, so nobody has to search for them and nobody can miss one.
 *
 * Nothing here suppresses the error — the guard test reads tsc's output for this filename.
 */
export const rules: PolicyRules = {
  'session.read': { admin: true, member: true },
  'diagnostics.run': { admin: true, member: true },
  'diagnostics.admin': { admin: true },
};
