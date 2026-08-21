import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque bearer tokens, and the one way they are stored.
 *
 * Sessions (ticket 2) and invitations (ticket 3) need the same thing: a value handed to somebody that
 * proves nothing but its own possession, with only a digest kept on our side. They share this
 * module rather than each growing a copy, because two copies is how one of them ends up storing
 * the raw value.
 *
 * SHA-256 rather than a password hash, deliberately. These are 256 bits of entropy from the
 * system's CSPRNG, not something a person chose — there is no dictionary to slow an attacker down
 * against, and a slow hash on a per-request session lookup would be a cost with nothing bought.
 */

/** 32 bytes, base64url — URL-safe, so the same value works in a cookie and in an emailed link. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored. A lookup by the raw token finds nothing, in any table that holds one. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
