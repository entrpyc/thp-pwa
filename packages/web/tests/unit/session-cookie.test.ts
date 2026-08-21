import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '@thp/shared';
import {
  SESSION_LIFETIME_MS,
  clearedSessionCookieHeader,
  generateSessionToken,
  hashSessionToken,
  readSessionCookie,
  sessionCookieHeader,
} from '@/server/auth/session';

const TOKEN = 'tYaXk3Q2-token-value_example';

function requestWithCookieHeader(value: string): Request {
  return new Request('http://127.0.0.1/api/v1/anything', { headers: { cookie: value } });
}

describe('the session cookie', () => {
  it('carries the flags that make it a session cookie rather than a string in a browser', () => {
    const header = sessionCookieHeader(TOKEN, new Date(Date.now() + SESSION_LIFETIME_MS));

    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    // The unit suite runs with NODE_ENV=test, which is "not development".
    expect(header).toContain('Secure');
  });

  it('has no Secure flag in development, where the origin is plain http://localhost', () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      expect(sessionCookieHeader(TOKEN, new Date(Date.now() + 1000))).not.toContain('Secure');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('expires in the future, by the session lifetime', () => {
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const header = sessionCookieHeader(TOKEN, expiresAt);
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);

    expect(maxAge).toBeGreaterThan(SESSION_LIFETIME_MS / 1000 - 60);
    expect(maxAge).toBeLessThanOrEqual(SESSION_LIFETIME_MS / 1000);
  });

  it('clears with an empty value and an immediate expiry', () => {
    const header = clearedSessionCookieHeader();

    expect(header).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
  });
});

describe('the session token', () => {
  it('is long, random and URL-safe', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('hashes deterministically, and the hash is not the token', () => {
    expect(hashSessionToken(TOKEN)).toBe(hashSessionToken(TOKEN));
    expect(hashSessionToken(TOKEN)).not.toBe(TOKEN);
    expect(hashSessionToken(TOKEN)).not.toContain(TOKEN);
    expect(hashSessionToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(`${TOKEN}x`)).not.toBe(hashSessionToken(TOKEN));
  });
});

describe('reading the cookie off a request', () => {
  it('finds it among other cookies, whichever position it is in', () => {
    expect(readSessionCookie(requestWithCookieHeader(`${SESSION_COOKIE_NAME}=${TOKEN}`))).toBe(TOKEN);
    expect(
      readSessionCookie(requestWithCookieHeader(`other=1; ${SESSION_COOKIE_NAME}=${TOKEN}; x=2`)),
    ).toBe(TOKEN);
  });

  it('returns null when there is no cookie, no such cookie, or an empty one', () => {
    expect(readSessionCookie(new Request('http://127.0.0.1/api/v1/anything'))).toBeNull();
    expect(readSessionCookie(requestWithCookieHeader('other=1; another=2'))).toBeNull();
    expect(readSessionCookie(requestWithCookieHeader(`${SESSION_COOKIE_NAME}=`))).toBeNull();
    expect(readSessionCookie(requestWithCookieHeader('malformed'))).toBeNull();
  });

  it('does not mistake a cookie whose name merely ends with ours', () => {
    expect(readSessionCookie(requestWithCookieHeader(`not_${SESSION_COOKIE_NAME}=${TOKEN}`))).toBeNull();
  });

  it('does not throw on a value that will not percent-decode', () => {
    // A cookie value is attacker-controlled. `decodeURIComponent('%%%')` throws, and a throw here
    // becomes a 500 where a 401 belongs.
    for (const broken of ['%%%', '%E0%A4%A', '%zz']) {
      expect(() => readSessionCookie(requestWithCookieHeader(`${SESSION_COOKIE_NAME}=${broken}`))).not.toThrow();
      expect(readSessionCookie(requestWithCookieHeader(`${SESSION_COOKIE_NAME}=${broken}`))).toBe(broken);
    }
  });
});
