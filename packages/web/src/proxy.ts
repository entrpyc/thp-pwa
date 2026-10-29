import { NextResponse, type NextRequest } from 'next/server';

/**
 * **The Content-Security-Policy, set per request** (docs/security-audit-2026-10-28.md, finding 6).
 *
 * This is the one header `next.config.ts`'s `headers()` cannot carry, because the policy names a
 * nonce and the nonce has to differ on every response: Next reads it back off this header
 * (`get-script-nonce-from-header`) and stamps it on the inline bootstrap scripts the App Router
 * emits, and `'strict-dynamic'` then lets those scripts load the chunks they reference. No script
 * that does not carry the nonce runs — which is the whole point. A cross-site scripting bug
 * somewhere in the tree would today give an attacker the session, the member's notes, and — in
 * the store shell — the Capacitor filesystem and push plugins exposed to the page. With this
 * header it gives them an injected string that the browser refuses to execute.
 *
 * **What is allowed, and why each line is there:**
 * - `script-src`: the nonce, and `'strict-dynamic'` so nonced scripts may load further ones.
 *   Development adds `'unsafe-eval'`, which the dev bundler's source-map evaluation needs; a
 *   production build never does.
 * - `style-src 'unsafe-inline'`: React writes `style=` attributes for the transport bar, the
 *   waveform and the progress rings, and Next injects the stylesheets inline in development.
 *   Style injection is not a code-execution primitive; the scripts are what this policy locks.
 * - `img-src` / `media-src` / `connect-src`: the app's own origin plus the media store's, which is
 *   where presigned uploads go, where audio and artwork are fetched from, and where the downloads
 *   screen pulls a file for offline keeping. `blob:` is the object URLs the player and the
 *   composer build; `data:` is the inline icons.
 * - `worker-src 'self'`: the service worker. `frame-ancestors 'none'` is the clickjacking lock;
 *   `object-src 'none'` and `base-uri 'self'` close the two classic escapes from a nonce policy;
 *   `form-action 'self'` means no form on this site can be re-targeted at another origin.
 *
 * **The Capacitor shell is unaffected.** On iOS the bridge is a `WKUserScript`; on Android it is
 * added with `addDocumentStartJavaScript`. Neither is a `<script>` in the document, so neither is
 * subject to the policy — and nothing the shell loads comes from a second origin.
 *
 * The media origin comes from `MEDIA_ENDPOINT`, read here on every request rather than at module
 * load so a misconfigured value fails the request it is read on, like the rest of the env readers.
 * When the store is unset (a mocked environment that never signs a URL) the directive simply
 * names the app's own origin.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce, {
    mediaOrigin: mediaOrigin(process.env['MEDIA_ENDPOINT']),
    // The API origin the client is built to call. In production it is the page's own origin and
    // adds nothing; a developer opening `127.0.0.1` against an origin configured as `localhost`
    // would otherwise have every fetch refused by `connect-src 'self'`.
    apiOrigin: mediaOrigin(process.env['NEXT_PUBLIC_API_ORIGIN']),
    development: process.env.NODE_ENV !== 'production',
  });

  // The request copy is what Next reads the nonce from while rendering; the response copy is what
  // the browser enforces. Both, or the inline bootstrap scripts are emitted without a nonce and
  // the page is blank.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', policy);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export interface PolicyOptions {
  /** The media store's origin, or `null` when there is none to name. */
  readonly mediaOrigin: string | null;
  /** The configured API origin, or `null`; named in `connect-src` when it is a second origin. */
  readonly apiOrigin?: string | null;
  /** Whether the dev bundler's needs (`eval`, the HMR socket) are allowed. */
  readonly development: boolean;
}

/** The policy as a header value. Exported so a test can hold it to the shape documented above. */
export function contentSecurityPolicy(nonce: string, options: PolicyOptions): string {
  const media = options.mediaOrigin === null ? '' : ` ${options.mediaOrigin}`;
  const api = options.apiOrigin == null ? '' : ` ${options.apiOrigin}`;
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:${media}`,
    `media-src 'self' blob:${media}`,
    `connect-src 'self'${api}${media}${options.development ? ' ws: wss:' : ''}`,
    `font-src 'self' data:`,
    `worker-src 'self'`,
    `manifest-src 'self'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ];
  return directives.join('; ');
}

/** The origin of a configured endpoint URL, or `null` for an unset or unparsable one. */
export function mediaOrigin(endpoint: string | undefined): string | null {
  const value = (endpoint ?? '').trim();
  if (value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export const config = {
  // Every document and API response. The built chunks are left out: they are what the nonced
  // scripts load, and a policy header on a JavaScript file governs nothing.
  matcher: ['/((?!_next/static/).*)'],
};
