import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { OFFLINE_PAGE_TEMPLATE_ID } from '@/client/offline/templates';

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

  it('passes a plain request to the network, and never caches sign-in, admin or the worker itself', () => {
    expect(offline.decide({ url: 'https://hub.test/' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/sign-in', rsc: true }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/admin/recordings', rsc: true }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/sw.js' }).kind).toBe('pass');
  });

  it('answers a navigation to a page it does not keep from the network, with the offline screen when there is none', () => {
    expect(offline.decide({ url: 'https://hub.test/sign-in', mode: 'navigate' })).toEqual({ kind: 'fallback' });
    expect(offline.decide({ url: 'https://hub.test/admin/recordings', mode: 'navigate' })).toEqual({ kind: 'fallback' });
    expect(offline.decide({ url: 'https://hub.test/search', mode: 'navigate' })).toEqual({ kind: 'fallback' });
    expect(offline.decide({ url: 'https://hub.test/search', mode: 'navigate', prefetch: true }).kind).toBe('pass');
  });

  it('never claims an API request, except to notice a session beginning or ending', () => {
    expect(offline.decide({ url: 'https://hub.test/api/v1/recordings?surface=library' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/recordings/r1/notes', method: 'POST' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/notifications' }).kind).toBe('pass');
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/session', method: 'DELETE' }).kind).toBe('sign-out');
    // A sign-in or sign-up is noticed too: the pages of whoever was here before go when the
    // server admits the next member, since a session can end without a sign-out (finding 21).
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/session', method: 'POST' }).kind).toBe('sign-in');
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/sign-up', method: 'POST' }).kind).toBe('sign-in');
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/session', method: 'GET' }).kind).toBe('pass');
    // The reset-request and other auth posts are not a session beginning.
    expect(offline.decide({ url: 'https://hub.test/api/v1/auth/password-reset', method: 'POST' }).kind).toBe('pass');
  });

  it('caches static chunks and member pages, in both the document and the RSC form', () => {
    expect(offline.decide({ url: 'https://hub.test/_next/static/chunks/app.js' }).kind).toBe('static');
    expect(offline.decide({ url: 'https://hub.test/recordings/r1', mode: 'navigate' })).toEqual({
      kind: 'page',
      key: 'https://hub.test/recordings/r1',
    });
    expect(offline.decide({ url: 'https://hub.test/recordings/r1?_rsc=abc', rsc: true })).toEqual({
      kind: 'page',
      key: 'https://hub.test/recordings/r1?__thp_rsc=1',
    });
    expect(offline.decide({ url: 'https://hub.test/recordings/r1', rsc: true, prefetch: true }).kind).toBe('pass');
    expect(offline.isMemberPage('/profile/downloads')).toBe(true);
    expect(offline.isMemberPage('/reset-password')).toBe(false);
  });

  it('never keeps the page that says who the device belonged to: the profile (finding 11)', () => {
    expect(offline.isMemberPage('/profile')).toBe(false);
    expect(offline.isMemberPage('/profile/settings')).toBe(false);
    expect(offline.decide({ url: 'https://hub.test/profile', mode: 'navigate' }).kind).toBe('fallback');
  });

  it('keeps the screens a member can act on offline (3.18.18)', () => {
    // None of these pages carries what it shows: each is drawn from the API, and offline from the
    // device's own copies, which go with the session.
    for (const path of [
      '/notes',
      '/highlights',
      '/prayer-requests',
      '/prayer-requests/new',
      '/flow-tracker',
      '/flow-tracker/start',
      '/notifications',
      '/profile/notifications',
    ]) {
      expect(offline.isMemberPage(path), path).toBe(true);
    }
  });

  it('finds the scripts and styles a document names, each once, so a kept page can come alive offline', () => {
    const extra = offline as unknown as { assetsNamedIn(html: string): string[] };
    const html = [
      '<link rel="stylesheet" href="/_next/static/css/app.abc123.css">',
      '<script src="/_next/static/chunks/main-9f8e.js" async></script>',
      '<script src="/_next/static/chunks/main-9f8e.js" async></script>',
      '<script>self.__next_f.push([1,"static/chunks/x.js \\"/_next/static/chunks/app/(member)/page-1a2b.js\\""])</script>',
      '<a href="/notes">Notes</a>',
    ].join('');
    expect(extra.assetsNamedIn(html)).toEqual([
      '/_next/static/css/app.abc123.css',
      '/_next/static/chunks/main-9f8e.js',
      '/_next/static/chunks/app/(member)/page-1a2b.js',
    ]);
  });

  it('answers a page that exists once per thing from one kept copy, with the id swapped', () => {
    const extra = offline as unknown as {
      TEMPLATE_ID: string;
      templateFor(key: string): { key: string; id: string } | null;
    };
    // The page and the worker name the same id; the worker cannot import the page's constant.
    expect(extra.TEMPLATE_ID).toBe(OFFLINE_PAGE_TEMPLATE_ID);
    const id = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
    expect(extra.templateFor(`https://hub.test/prayer-requests/${id}`)).toEqual({
      key: `https://hub.test/prayer-requests/${OFFLINE_PAGE_TEMPLATE_ID}`,
      id,
    });
    // The RSC form keeps its marker, so the two forms of the template stay two entries.
    expect(extra.templateFor(`https://hub.test/flow-tracker/sessions/${id}?__thp_rsc=1`)).toEqual({
      key: `https://hub.test/flow-tracker/sessions/${OFFLINE_PAGE_TEMPLATE_ID}?__thp_rsc=1`,
      id,
    });
    // Not a page of that kind, and the template is not its own stand-in.
    expect(extra.templateFor('https://hub.test/prayer-requests/new')).toBeNull();
    expect(extra.templateFor(`https://hub.test/recordings/${id}`)).toBeNull();
    expect(extra.templateFor(`https://hub.test/prayer-requests/${OFFLINE_PAGE_TEMPLATE_ID}`)).toBeNull();
  });

  it('keys a page without the per-request token Next appends, so a cold start finds the copy', () => {
    expect(offline.pageKey(new URL('https://hub.test/series/s1?_rsc=zzz'), false)).toBe('https://hub.test/series/s1');
    // The RSC marker is a query parameter: the Cache API ignores fragments, so a fragment marker
    // made the document and the RSC payload one entry that overwrote each other (finding 11).
    expect(offline.pageKey(new URL('https://hub.test/recordings/r1?tab=chapters&_rsc=zzz'), true)).toBe(
      'https://hub.test/recordings/r1?tab=chapters&__thp_rsc=1',
    );
    expect(offline.pageKey(new URL('https://hub.test/recordings/r1'), true)).not.toBe(
      offline.pageKey(new URL('https://hub.test/recordings/r1'), false),
    );
  });
});
