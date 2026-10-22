'use client';

import { useEffect } from 'react';
import { serviceWorkerUpdates, serviceWorkerUrl } from './service-worker-update';

/**
 * Registers `public/sw.js`, watches for a newer worker taking over, and renders nothing.
 *
 * It is mounted in the root layout rather than the member one because Chrome decides whether to
 * offer the install prompt on whichever page the member happens to be looking at — including
 * sign-in, which is where someone arriving at the hub for the first time actually stands.
 *
 * The script URL carries the release (`serviceWorkerUrl`), which is what makes every deploy a new
 * worker — see the header of `public/sw.js`. `updateViaCache: 'none'` keeps the browser from
 * serving the worker or its imported modules out of the HTTP cache, so the fresh URL fetches fresh
 * code. Registration is best-effort: it throws where the page is not a secure context — plain
 * `http://` on a phone on the LAN, say — and the only consequence is that Chrome withholds the
 * install prompt, so the failure is swallowed rather than surfaced to a member who can do nothing
 * about it.
 *
 * **Learning about an update.** Two events, because they answer different questions:
 *
 * - `updatefound` on the registration says a newer worker is *installing*. Its `statechange` to
 *   `installed` is the moment the new code is in place; with `skipWaiting` it activates straight
 *   after.
 * - `controllerchange` on the container says the new worker now *controls this page* — the fact a
 *   banner would actually be about. It also fires on the very first install, when `clients.claim`
 *   gives an uncontrolled page its first controller, and that is not an update: so it only counts
 *   when the page already had a controller when it loaded.
 *
 * Either one marks the store; a page that saw both marks it once. Nothing is reloaded here — a
 * reload mid-playback is the kind of interruption a later ticket should decide on, not a side
 * effect of registering.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const container = navigator.serviceWorker;
    // Mutable on purpose: a tab that opened uncontrolled and was claimed by the first install is
    // controlled from then on, so a second deploy during the same visit is an update for it too.
    let hadController = container.controller !== null;

    const onControllerChange = () => {
      if (hadController) serviceWorkerUpdates.markUpdateAvailable();
      hadController = true;
    };
    container.addEventListener('controllerchange', onControllerChange);

    void container
      .register(serviceWorkerUrl(process.env.NEXT_PUBLIC_APP_VERSION), {
        scope: '/',
        updateViaCache: 'none',
      })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing || !hadController) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') serviceWorkerUpdates.markUpdateAvailable();
          });
        });
      })
      .catch(() => undefined);

    return () => {
      container.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  return null;
}
