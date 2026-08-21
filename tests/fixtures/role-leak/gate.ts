/**
 * A deliberate violation, so tools/role-usage.ts can be seen failing. Never imported by anything.
 *
 * This is what an authorisation decision made outside the policy module looks like: a role read off
 * an object and compared against a literal, at the call site, where nobody widens it when a fourth
 * role arrives.
 */
export function mayUpload(actor: { role: string }): boolean {
  return actor.role === 'admin';
}
