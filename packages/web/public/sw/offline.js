/*
 * Offline downloads (PRD 3.18). Loaded by `/sw.js`; see its header for how modules compose.
 *
 * This is where the `fetch` handler that serves a downloaded teaching's media and the cached data
 * that goes with it will go. It will answer only for items a member explicitly downloaded and fall
 * through to the network for everything else — never the app shell, for the reason the core's
 * header gives: a cached shell would render member chrome to a signed-out visitor before the
 * server could redirect. The downloads ticket replaces the body and touches no other file.
 *
 * Until then the handler responds to nothing, which leaves every request going to the network
 * exactly as it would with no worker at all. It still has to exist: Chrome withholds the install
 * prompt from a page whose worker has no `fetch` listener, so this empty function is what makes
 * the hub installable.
 */

self.addEventListener('fetch', () => {});
