'use client';

import { useEffect } from 'react';

/**
 * Registers `public/sw.js`, and renders nothing.
 *
 * It is mounted in the root layout rather than the member one because Chrome decides whether to
 * offer the install prompt on whichever page the member happens to be looking at — including
 * sign-in, which is where someone arriving at the hub for the first time actually stands.
 *
 * `updateViaCache: 'none'` keeps the browser from serving a stale worker out of the HTTP cache, so
 * a deployed change to `sw.js` is picked up on the next launch. Registration is best-effort: it
 * throws where the page is not a secure context — plain `http://` on a phone on the LAN, say — and
 * the only consequence is that Chrome withholds the install prompt, so the failure is swallowed
 * rather than surfaced to a member who can do nothing about it.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  }, []);

  return null;
}
