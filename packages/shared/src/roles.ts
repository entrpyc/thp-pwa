/**
 * The role enum. Declared here exactly once for the whole repository: the client, the API, the
 * worker and the database layer all read it from this module rather than restating it.
 *
 * `contributor` is deliberately absent — slice 01 has two roles only
 * (docs/implementation-plan.md, Step 2).
 */
export const ROLES = ['admin', 'member'] as const;

export type Role = (typeof ROLES)[number];

/**
 * The roles by name. Everywhere else in `src/` spells a role as `ROLE.admin` rather than as the
 * string `'admin'`, so the role-usage guard (tools/role-usage.ts) can say something absolute: a
 * role literal outside this file is a violation, with no "except when it is only a value" carve-out
 * to argue about.
 */
export const ROLE = { admin: 'admin', member: 'member' } as const satisfies Record<Role, Role>;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
