import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * **The offline module's decisions, without a browser** (docs/project/prd.md 3.18.13;
 * `public/sw/offline.js`).
 *
 * The module is evaluated the way `service-worker.test.ts` evaluates the core, and its pure
 * functions are read back off `self.THP_OFFLINE`: what is cached, what is passed through — and
 * that nothing under `/api/v1` is ever claimed, which is what keeps the suite's stubbed requests
 * and the page's own offline answers honest.
 */
const PUBLIC_DIR = resolve(import.meta.dirname, '..', '..', 'public');
const SOURCE = readFileSync(resolve(PUBLIC_DIR, 'sw', 'offline.js'), 'utf8');

interface Offline {
  decide(input: Record<string, unknown>): { kind: string; key?: string };
  pageKey(url: URL, isRsc: boolean): string;
  isMemberPage(path: string): boolean;
}

function evaluate(): { offline: Offline; listeners: Map<string, ((event: unknown) => unknown)[]> } {
  const listeners = new Map<string, ((event: unknown) => unknown)[]>();
  const self: Record<string, unknown> = {
    location: { href: 'https://hub.test/sw.js', origin: 'https://hub.test' },
    addEventListener(type: string, handler: (event: unknown) => unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
  };
  runInNewContext(SOURCE, { self, URL, Response: class {} }, { filename: 'offline.js' });
  return { offline: self.THP_OFFLINE as Offline, listeners };
}

describe('what the worker decides', () => {
  const { offline, listeners } = evaluate();

  it('registers one fetch handler and one message handler', () => {
    expect(listeners.get('fetch')).toHaveLength(1);
    expect(listeners.get('message')).toHaveLength(1);
  });

  it('passes a plain request to the network, and never touches sign-in, admin or the worker itself', () => {
    expect(offline.decide({ url: 'https://hub.test/' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/sign-in', mode: 'navigate' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/admin/recordings', mode: 'navigate' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/sw.js', mode: 'navigate' }).kind).toBe('pass');
  });

  it('never claims an API request, except to notice the sign-out', () => {
    expect(offline.decide({ url: 'https://hub.test/api/v1/recordings?surface=library' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/recordings/r1/notes', method: 'POST' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/notifications' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/session', method: 'DELETE' }).kind).toBe('sign-out');
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/session', method: 'GET' }).kind).toBe('pass');
  });

  it('caches static chunks and member pages, in both the document and the RSC form', () => {
    expect(offline.decide({ url: 'https://hub.test/_next/static/chunks/app.js' }).kind).toBe('static');
    expect(offline.decide({ url: 'https://hub.test/recordings/r1', mode: 'navigate' })).toEqual({
      kind: 'page',
      key: 'https://hub.test/recordings/r1',
    });
    expect(offline.decide({ url: 'https://hub.test/recordings/r1?_rsc=abc', rsc: true })).toEqual({
      kind: 'page',
      key: 'https://hub.test/recordings/r1#rsc',
    });
    expect(offline.decide({ url: 'https://hub.test/recordings/r1', rsc: true, prefetch: true }).kind).toBe('pass');
    expect(offline.isMemberPage('/profile/downloads')).toBe(true);
    expect(offline.isMemberPage('/reset-password')).toBe(false);
  });

  it('keys a page without the per-request token Next appends, so a cold start finds the copy', () => {
    expect(offline.pageKey(new URL('https://hub.test/series/s1?_rsc=zzz'), false)).toBe('https://hub.test/series/s1');
    expect(offline.pageKey(new URL('https://hub.test/recordings/r1?tab=chapters&_rsc=zzz'), true)).toBe(
      'https://hub.test/recordings/r1?tab=chapters#rsc',
    );
  });
});
