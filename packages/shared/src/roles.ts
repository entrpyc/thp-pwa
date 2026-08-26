/**
 * The role enum. Declared here exactly once for the whole repository: the client, the API, the
 * worker and the database layer all read it from this module rather than restating it.
 *
 * `contributor` is deliberately absent — this epic has two roles only
 * (core-listening scope plan, Ticket 2).
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

/**
 * What a role is called on screen. Declared beside the enum rather than in the console, because
 * tools/role-usage.ts refuses a role literal anywhere outside this file — so a picker or a tag
 * built anywhere else would have to spell one, and the guard would be right to stop it.
 *
 * `Record<Role, string>` rather than a lookup with a fallback: adding a role to {@link ROLES} stops
 * the build until it has a name, which is the same property {@link ROLE} and the policy table both
 * have, and the reason Contributor arriving is a compiler error rather than an unlabelled pill.
 *
 * Iterate {@link ROLES} to build a picker; never restate the list.
 */
export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', member: 'Member' };
