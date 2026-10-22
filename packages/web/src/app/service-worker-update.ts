import { useSyncExternalStore } from 'react';

/**
 * The worker's script URL for a release. The query string is the whole versioning scheme — see the
 * header of `public/sw.js` — so this is the one place it is spelled, and the registration and the
 * screen test both read it from here rather than agreeing on a string. An empty or missing version
 * is a build with no git, which `next.config.ts` already calls `dev`.
 */
export const SERVICE_WORKER_PATH = '/sw.js';

export function serviceWorkerUrl(version: string | undefined): string {
  return `${SERVICE_WORKER_PATH}?v=${encodeURIComponent(version || 'dev')}`;
}

/**
 * **Whether a newer worker has taken over since the page loaded.**
 *
 * The worker uses `skipWaiting` and `clients.claim`, so a new release does not wait for the member
 * to close every tab — it is already in control. What an open page does about that is a later
 * ticket's decision (a banner, a reload offer, nothing); this is only the fact, kept somewhere a
 * component can subscribe to. It is a store rather than React state in the registration component
 * because that component renders nothing and sits in the root layout, and a banner will live
 * somewhere else entirely.
 *
 * The flag only ever goes from `false` to `true`. A page is loaded under one worker; once a second
 * has replaced it the page is behind, and stays behind until it reloads.
 */
export interface ServiceWorkerUpdateStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
  /** Record that a newer worker now controls the page. Idempotent. */
  readonly markUpdateAvailable: () => void;
}

export function createServiceWorkerUpdateStore(): ServiceWorkerUpdateStore {
  let updateAvailable = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => updateAvailable,
    markUpdateAvailable() {
      if (updateAvailable) return;
      updateAvailable = true;
      for (const listener of listeners) listener();
    },
  };
}

/** The one store the registration feeds and {@link useServiceWorkerUpdate} reads. */
export const serviceWorkerUpdates = createServiceWorkerUpdateStore();

/**
 * `{ updateAvailable }` for a component that wants to tell the member a newer release is running.
 * Always `false` on the server and on the first client render, so hydration cannot disagree with
 * the markup — the flag can only become true after a worker event, which is after mount.
 */
export function useServiceWorkerUpdate(): { readonly updateAvailable: boolean } {
  const updateAvailable = useSyncExternalStore(
    serviceWorkerUpdates.subscribe,
    serviceWorkerUpdates.getSnapshot,
    () => false,
  );
  return { updateAvailable };
}
