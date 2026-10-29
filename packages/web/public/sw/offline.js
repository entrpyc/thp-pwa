/*
 * Offline pages (PRD 3.18; project tdd 2.1). Loaded by `/sw.js`; see its header for how modules
 * compose.
 *
 * What this module does, and the rule it keeps:
 *
 * 1. **Static chunks** (`/_next/static/*`) are cache-first. They are hashed, immutable and public;
 *    nothing about a member is in them.
 * 2. **Member pages** are network-first, and a copy is kept only after the server answered a
 *    signed-in member with 200. The copy is served only when the network cannot be reached, never
 *    ahead of it — so a signed-out visitor online still meets the server's redirect — and the
 *    whole page cache is dropped when the sign-out request passes through here, **and again when
 *    a sign-in or sign-up succeeds** — a session can end without a sign-out (it expires, an admin
 *    deactivates the account, the tab was closed first), and the next member's sign-in is the
 *    moment the previous member's pages must already be gone (security audit 2026-10-28, finding
 *    21). That is how the core's "no cached shell" rule survives offline: nothing cached is ever
 *    shown to somebody the server has not just admitted, except on a device where that member
 *    signed in and lost signal.
 * 3. **Warming** (`thp:warm`): a download pre-fetches the pages it will need, in both forms a page
 *    is requested in, so a teaching downloaded online opens offline without having been visited.
 * 4. **Every other navigation** — sign-in, the console, the member pages that need the server to
 *    mean anything — goes to the network and is never kept, but when the network cannot be reached
 *    the member sees the app's own screen saying the page is not accessible offline, instead of
 *    the browser's. The same screen answers a member page with no copy.
 *
 * What it deliberately does **not** do: answer `/api/v1` requests. The library, a series and a
 * downloaded teaching's chapters, scripture and notes are answered offline by the page itself
 * (`src/client/offline/offline-api.ts`) from the same IndexedDB the download wrote — the page can
 * do that, and a worker proxying API reads would answer the suite's stubbed requests from the
 * network. The worker keeps only what a page cannot do for itself: be there before it loads.
 *
 * Every request this module does not claim goes to the network exactly as it would with no
 * worker. The decisions are pure functions on `self.THP_OFFLINE` so the unit test can drive them.
 */

const API_PREFIX = '/api/v1';
const SIGN_OUT_PATH = `${API_PREFIX}/auth/session`;
/** `POST` here is a sign-in (the same resource as the sign-out), and `POST` sign-up is one too. */
const SIGN_IN_PATHS = [`${API_PREFIX}/auth/session`, `${API_PREFIX}/auth/sign-up`];
const PAGE_CACHE = 'thp-pages-v1';
const STATIC_CACHE = 'thp-static-v1';
/** The member surface. Anything else — sign-in, admin, the public pages — is never cached. */
const MEMBER_PAGE_PREFIXES = ['/', '/recordings', '/series', '/now-playing', '/notifications', '/profile', '/feedback'];

// ------------------------------------------------------------------------------------- decisions

/**
 * What to do with a request, from its method, path and two headers. Pure.
 *
 * `{ kind: 'pass' }` means "not ours": the handler never calls `respondWith`, so the request goes
 * to the network exactly as it would with no worker.
 */
function decide(input) {
  const url = new URL(input.url);
  const path = url.pathname;
  const method = (input.method || 'GET').toUpperCase();

  if (path.startsWith('/_next/static/')) return { kind: 'static' };
  if (method === 'DELETE' && path === SIGN_OUT_PATH) return { kind: 'sign-out' };
  if (method === 'POST' && SIGN_IN_PATHS.includes(path)) return { kind: 'sign-in' };
  if (path.startsWith(API_PREFIX)) return { kind: 'pass' };

  const isRsc = input.rsc === true;
  if (input.mode === 'navigate' || isRsc) {
    if (input.prefetch === true) return { kind: 'pass' };
    if (!isMemberPage(path)) {
      // A document for anything else: the network, and the offline screen when it cannot be
      // reached. The RSC form of such a page is not claimed — Next falls back to a full
      // navigation when that fetch fails, and the full navigation lands here.
      return input.mode === 'navigate' ? { kind: 'fallback' } : { kind: 'pass' };
    }
    return { kind: 'page', key: pageKey(url, isRsc) };
  }
  return { kind: 'pass' };
}

function isMemberPage(path) {
  return MEMBER_PAGE_PREFIXES.some((prefix) =>
    prefix === '/' ? path === '/' : path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** The cache key for a page: the path, with Next's per-request `_rsc` token dropped, and a marker for the RSC form. */
function pageKey(url, isRsc) {
  const copy = new URL(url.href);
  copy.searchParams.delete('_rsc');
  copy.hash = '';
  return `${copy.origin}${copy.pathname}${copy.search}${isRsc ? '#rsc' : ''}`;
}

self.THP_OFFLINE = { decide, pageKey, isMemberPage };

// --------------------------------------------------------------------------------------- handlers

async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const held = await cache.match(request);
  if (held) return held;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/*
 * The screen for a page that cannot be shown offline. Self-contained — no stylesheet of the app's
 * is guaranteed to be cached — so the colours are the token values written out (`tokens.css`:
 * `--color-bg`, `--color-text`, `--color-text-muted`, `--color-primary-icon`). Try again
 * reloads, which is the only thing that helps once the signal is back; the dashboard link leads to
 * the one page a member with downloads most likely has a copy of.
 */
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Not accessible offline</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,-apple-system,sans-serif;background:#01101F;color:#FCFCFC}main{max-width:28rem;padding:24px;text-align:center}h1{font-size:1.125rem;margin:0 0 12px}p{margin:0 0 24px;font-size:0.875rem;line-height:1.5;color:#8A97AC}a,button{display:inline-block;margin:0 8px;font:inherit;font-size:0.875rem;color:#8B5CF6;background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline}</style></head><body><main><h1>This page is not accessible offline.</h1><p>You are offline, and this page is not saved on this device. Your downloaded teachings are still here.</p><button type="button" onclick="location.reload()">Try again</button><a href="/">Go to the dashboard</a></main></body></html>`;

/** The offline screen as a response: a 503, so nothing caches it as the page. */
function offlineResponse() {
  return new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** A document that is never kept: the network, or the offline screen when there is none. */
async function handleFallback(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

async function handlePage(request, key) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    // Kept only when the server admitted this member: a redirect to sign-in is not a page to keep.
    if (response.ok && response.type === 'basic' && !response.redirected) {
      await cache.put(key, response.clone());
    }
    return response;
  } catch (caught) {
    const held = await cache.match(key);
    if (held) return held;
    if (request.mode === 'navigate') return offlineResponse();
    throw caught;
  }
}

async function handleSignOut(request) {
  const response = await fetch(request);
  // The pages go with the session, whatever the server said: a cached page is only ever shown to
  // the member it was served to, and that member has just left this device. Downloads stay —
  // scoped to the account, by the operator's decision — and the page clears its own active-user
  // marker.
  await caches.delete(PAGE_CACHE).catch(() => undefined);
  return response;
}

/**
 * A sign-in or a sign-up that the server accepted. Whatever this device still holds was rendered
 * for whoever was here before — a member whose session ended without passing through
 * `handleSignOut` — and the member who has just been admitted must not be able to reach it, online
 * or off. Only on success: a refused attempt changes nothing about who is signed in.
 */
async function handleSignIn(request) {
  const response = await fetch(request);
  if (response.ok) await caches.delete(PAGE_CACHE).catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const header = (name) => (request.headers && typeof request.headers.get === 'function' ? request.headers.get(name) : null);
  const decision = decide({
    url: request.url,
    method: request.method,
    mode: request.mode,
    rsc: header('RSC') === '1',
    prefetch: header('Next-Router-Prefetch') === '1',
  });
  switch (decision.kind) {
    case 'static':
      event.respondWith(handleStatic(request));
      break;
    case 'page':
      event.respondWith(handlePage(request, decision.key));
      break;
    case 'fallback':
      event.respondWith(handleFallback(request));
      break;
    case 'sign-out':
      event.respondWith(handleSignOut(request));
      break;
    case 'sign-in':
      event.respondWith(handleSignIn(request));
      break;
    default:
      break;
  }
});

/**
 * Pre-fetch the pages a download will need (`thp:warm`), in both forms a page is requested in —
 * the document for a cold start and the RSC payload for a client-side navigation — so a teaching
 * downloaded online opens offline without ever having been visited.
 */
async function warm(urls) {
  const cache = await caches.open(PAGE_CACHE);
  for (const path of urls) {
    const url = new URL(path, self.location.origin);
    if (!isMemberPage(url.pathname)) continue;
    for (const rsc of [false, true]) {
      try {
        const response = await fetch(url.href, {
          credentials: 'same-origin',
          headers: rsc ? { RSC: '1' } : {},
        });
        if (response.ok && !response.redirected) await cache.put(pageKey(url, rsc), response);
      } catch {
        // Offline already; the next download tries again.
      }
    }
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'thp:warm' && Array.isArray(data.urls)) event.waitUntil(warm(data.urls));
  if (data.type === 'thp:purge-pages') event.waitUntil(caches.delete(PAGE_CACHE));
});
