// A deliberate duplicate of the shared role enum, used to prove the uniqueness check fails.
export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
