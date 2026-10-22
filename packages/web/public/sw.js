/*
 * The service worker: a core that owns the lifecycle, plus one file per feature under `/sw/`.
 *
 * **Composition.** This file registers `install` and `activate` and nothing else, then pulls in
 * the feature modules with `importScripts`. Each module is a plain script that registers its own
 * handlers on `self` — `sw/push.js` owns `push` and `notificationclick` (PRD 3.17.1), `sw/offline.js`
 * owns `fetch` (PRD 3.18) — so a ticket that lands one of them edits one file and this list, never
 * the other module. `importScripts` rather than a bundler because there is nothing to bundle: the
 * modules share no code, the worker has no dependencies, and a build step would be a second thing
 * for a deploy to get wrong. Modules stay plain JavaScript with doc comments; they are outside
 * `tsconfig`'s `include` and typecheck does not see them, which is why the unit test evaluates them.
 *
 * **Versioning.** The page registers `/sw.js?v=<release>`, where the release is
 * `NEXT_PUBLIC_APP_VERSION` — the git tag or short commit `next.config.ts` stamps into every build.
 * A different query string is a different script URL to the browser, so every deploy installs a new
 * worker whether or not this file changed. The version is read back out of the worker's own URL and
 * threaded onto the module imports below, so the modules are fetched fresh with the core rather
 * than depending on the browser's byte-comparison of imported scripts, which varies by engine.
 * There is no hand-bumped constant to forget.
 *
 * **Updates.** `skipWaiting` plus `clients.claim` means the new worker takes over every open tab as
 * soon as it has installed, rather than after the last tab closes. Nothing is cached here — not the
 * app shell, not a route — so there is no old version to strand and taking control costs nothing.
 * An open app learns about it from `service-worker-registration.tsx`, which watches `updatefound`
 * and `controllerchange` and feeds `useServiceWorkerUpdate()`; nothing in the UI reads that yet.
 *
 * **Why nothing is cached.** Caching the app shell would mean a second, invisible copy of the
 * routing and auth story: a cached shell served to a signed-out member would render the member
 * chrome before the server got the chance to redirect to sign-in. The offline module is where
 * downloaded media and the data a member chose to keep will be served from, and that is a
 * deliberate per-item store, not the shell. Chrome's install prompt needs a `fetch` handler to
 * exist, and the offline module's no-op one is what satisfies it.
 */

/**
 * The release this worker was registered under, taken from its own URL so the modules below are
 * fetched under the same version. `dev` is what a registration with no version at all would be —
 * a hand-typed URL in a browser, not anything the app does.
 */
const SW_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
self.THP_SW_VERSION = SW_VERSION;

importScripts(
  `/sw/push.js?v=${encodeURIComponent(SW_VERSION)}`,
  `/sw/offline.js?v=${encodeURIComponent(SW_VERSION)}`,
);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
