/**
 * The role enum. Declared here exactly once for the whole repository: the client, the API, the
 * worker and the database layer all read it from this module rather than restating it.
 *
 * `contributor` is deliberately absent — slice 01 has two roles only
 * (docs/implementation-plan.md, Step 2).
 */
export const ROLES = ['admin', 'member'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
