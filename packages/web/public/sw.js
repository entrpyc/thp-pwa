/*
 * The service worker exists to satisfy Chrome's installability check, and deliberately does no
 * more than that.
 *
 * Chrome withholds the install prompt from a page whose worker has no `fetch` handler. The handler
 * does not have to serve anything — responding to nothing leaves every request to go to the
 * network exactly as it would without a worker — so this is the whole of it. Caching the app shell
 * here would mean a second, invisible copy of the routing and auth story: a cached shell served to
 * a signed-out member would render the member chrome before the server got the chance to redirect
 * to sign-in. Offline support belongs with `experimental.useOffline`, which is framework-level and
 * knows about navigations; it is not this file's job.
 *
 * `skipWaiting` plus `clients.claim` means a deployed change to this file takes effect on the next
 * launch rather than after every tab closes. With no cached assets there is no version to strand,
 * so taking control immediately costs nothing.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {});
