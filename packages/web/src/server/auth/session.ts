import {
  findLiveSessionByTokenHash,
  insertSession,
  revokeSessionByTokenHash,
  touchSession,
} from '@thp/db';
import { SESSION_COOKIE_NAME } from '@thp/shared';
import { generateToken, hashToken } from './tokens';
import { toActor, type Actor } from './policy';

/**
 * Sessions: an opaque token in an HTTP-only cookie, a row in `session` holding only its hash.
 *
 * The cookie value is 32 random bytes and says nothing — not the user id, not the email, not the
 * role. Everything about the caller is re-read from the database on every request, which is what
 * makes a role change (and, from ticket 4, a deactivation) take effect immediately rather than at
 * the next sign-in.
 */

/**
 * 30 days, rolling. This is a personal-device teaching library; being signed out weekly is friction
 * with no security case behind it, and sign-out is real because the record is server-side.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale a session must be before using it rolls the window forward. Without this every request
 * would write a row; with it, a session in constant use is refreshed at most hourly and still never
 * expires under someone.
 */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

/**
 * The cookie value, and its digest. Both are the shared helpers in `./tokens`, which ticket 3's
 * invitation tokens also read — same shape, same storage rule, one implementation.
 */
export const generateSessionToken = generateToken;
export const hashSessionToken = hashToken;

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issueSession(userId: string): Promise<IssuedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await insertSession({ userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt };
}

/**
 * Resolve a cookie value to an actor, or `null`.
 *
 * `null` covers every failure identically — absent, mutated, forged, revoked, expired — so a
 * tampered cookie produces a clean refusal rather than a `500`.
 */
export async function actorForToken(token: string | null | undefined): Promise<Actor | null> {
  if (!token) return null;
  const live = await findLiveSessionByTokenHash(hashSessionToken(token));
  if (!live) return null;

  if (Date.now() - live.session.lastUsedAt.getTime() > REFRESH_AFTER_MS) {
    await touchSession(live.session.id, new Date(Date.now() + SESSION_LIFETIME_MS));
  }
  return toActor(live.user);
}

/** End the session behind this cookie. Returns whether there was a live one to end. */
export async function revokeSession(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  return revokeSessionByTokenHash(hashSessionToken(token));
}

/**
 * Read our cookie out of a request. Hand-parsed rather than taken from `next/headers`, so the same
 * function serves a route handler and a test that holds only a `Request`.
 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    return decodeCookieValue(part.slice(separator + 1).trim()) || null;
  }
  return null;
}

/**
 * A cookie value is attacker-controlled, and `decodeURIComponent('%%%')` throws. Taking the raw
 * value when it will not decode keeps a malformed cookie on the ordinary "no such session" path —
 * a clean `401` — instead of turning it into a `500`, which is the difference between refusing and
 * failing.
 */
function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `Secure` everywhere except development. Development is `next dev` over plain `http://localhost`,
 * where the flag would be a nuisance and the exposure is a loopback interface. The integration and
 * browser suites run the production build over `http://127.0.0.1`, keep the flag, and still work —
 * browsers treat loopback as a secure context.
 */
function isSecureContext(): boolean {
  return process.env['NODE_ENV'] !== 'development';
}

export function sessionCookieHeader(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    ...(isSecureContext() ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(isSecureContext() ? ['Secure'] : []),
  ].join('; ');
}
