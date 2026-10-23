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
 *    whole page cache is dropped when the sign-out request passes through here. That is how the
 *    core's "no cached shell" rule survives offline: nothing cached is ever shown to somebody the
 *    server has not just admitted, except on a device where that member signed in and lost signal.
 * 3. **Warming** (`thp:warm`): a download pre-fetches the pages it will need, in both forms a page
 *    is requested in, so a teaching downloaded online opens offline without having been visited.
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
  if (path.startsWith(API_PREFIX)) return { kind: 'pass' };

  const isRsc = input.rsc === true;
  if (input.mode === 'navigate' || isRsc) {
    if (input.prefetch === true) return { kind: 'pass' };
    if (!isMemberPage(path)) return { kind: 'pass' };
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

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;background:#01101F;color:#FCFCFC}main{max-width:28rem;padding:24px;text-align:center}a{color:#8B5CF6}</style></head><body><main><h1>You are offline</h1><p>This page has not been opened on this device while connected, so there is no copy to show. Your downloaded teachings are still here: <a href="/">go to the dashboard</a>.</p></main></body></html>`;

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
    if (request.mode === 'navigate') {
      return new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
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
    case 'sign-out':
      event.respondWith(handleSignOut(request));
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
