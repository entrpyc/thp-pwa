import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { createServiceWorkerUpdateStore, serviceWorkerUrl } from '@/app/service-worker-update';

/**
 * **The worker's shape, without a browser.**
 *
 * `public/sw.js` and the modules under `public/sw/` are plain scripts outside `tsconfig`, so
 * nothing but a browser would ever notice a handler that stopped being registered or an import
 * that went to the wrong path. This evaluates them the way a worker would — a `self` that records
 * listeners, an `importScripts` that resolves `/sw/*.js` to the files on disk — and asserts the
 * contract the two later tickets and Chrome's install check depend on: every lifecycle and feature
 * handler is registered, the modules are fetched under the core's version, and nothing is served
 * from a cache.
 */

const PUBLIC_DIR = resolve(import.meta.dirname, '..', '..', 'public');

type Handler = (event: unknown) => unknown;

interface FakeWorker {
  readonly self: Record<string, unknown>;
  readonly listeners: Map<string, Handler[]>;
  readonly imported: string[];
  readonly skipWaiting: ReturnType<typeof vi.fn>;
  readonly claim: ReturnType<typeof vi.fn>;
}

function evaluateWorker(href: string): FakeWorker {
  const listeners = new Map<string, Handler[]>();
  const imported: string[] = [];
  const skipWaiting = vi.fn();
  const claim = vi.fn(() => Promise.resolve());
  const self: Record<string, unknown> = {
    location: { href },
    skipWaiting,
    clients: { claim },
    addEventListener(type: string, handler: Handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
  };
  const sandbox = {
    self,
    URL,
    encodeURIComponent,
    importScripts(...urls: string[]) {
      for (const url of urls) {
        imported.push(url);
        const file = resolve(PUBLIC_DIR, `.${new URL(url, 'https://hub.test').pathname}`);
        runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: url });
      }
    },
  };
  runInNewContext(readFileSync(resolve(PUBLIC_DIR, 'sw.js'), 'utf8'), sandbox, {
    filename: 'sw.js',
  });
  return { self, listeners, imported, skipWaiting, claim };
}

describe('the composed worker', () => {
  const worker = evaluateWorker('https://hub.test/sw.js?v=v1.4.0');

  it('loads the push and offline modules under its own version', () => {
    expect(worker.imported).toEqual(['/sw/push.js?v=v1.4.0', '/sw/offline.js?v=v1.4.0']);
    expect(worker.self.THP_SW_VERSION).toBe('v1.4.0');
  });

  it.each([
    ['install', 'the core'],
    ['activate', 'the core'],
    ['fetch', 'the offline module'],
    ['push', 'the push module'],
    ['notificationclick', 'the push module'],
  ])('registers exactly one %s handler, from %s', (type) => {
    expect(worker.listeners.get(type)).toHaveLength(1);
  });

  it('takes over on install rather than waiting for every tab to close', () => {
    worker.listeners.get('install')?.[0]?.({});
    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);

    const waitUntil = vi.fn();
    worker.listeners.get('activate')?.[0]?.({ waitUntil });
    expect(worker.claim).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('answers no request itself, so nothing is ever served from a cache', () => {
    const respondWith = vi.fn();
    worker.listeners.get('fetch')?.[0]?.({ request: { url: 'https://hub.test/' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('calls a worker registered with no version "dev", like the build does', () => {
    expect(evaluateWorker('https://hub.test/sw.js').self.THP_SW_VERSION).toBe('dev');
  });
});

describe('the registration URL', () => {
  it('carries the release, so a deploy is a new worker', () => {
    expect(serviceWorkerUrl('v1.4.0')).toBe('/sw.js?v=v1.4.0');
    expect(serviceWorkerUrl('v1.4.0-3-gabc1234')).toBe('/sw.js?v=v1.4.0-3-gabc1234');
  });

  it('is "dev" for a build with no git, never an empty parameter', () => {
    expect(serviceWorkerUrl(undefined)).toBe('/sw.js?v=dev');
    expect(serviceWorkerUrl('')).toBe('/sw.js?v=dev');
  });
});

describe('the update store a banner would subscribe to', () => {
  it('starts false and notifies once when a newer worker takes over', () => {
    const store = createServiceWorkerUpdateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.getSnapshot()).toBe(false);

    store.markUpdateAvailable();
    store.markUpdateAvailable();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', () => {
    const store = createServiceWorkerUpdateStore();
    const listener = vi.fn();
    store.subscribe(listener)();
    store.markUpdateAvailable();
    expect(listener).not.toHaveBeenCalled();
  });
});
