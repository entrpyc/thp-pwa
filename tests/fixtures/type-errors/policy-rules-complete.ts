import type { PolicyRules } from '@/server/auth/policy';

/**
 * The positive control for the exhaustiveness fixture: a rules table with an answer for every role
 * of every action compiles.
 */
export const rules: PolicyRules = {
  'session.read': { admin: true, member: true },
  'diagnostics.run': { admin: true, member: true },
  'diagnostics.admin': { admin: true, member: false },
};
