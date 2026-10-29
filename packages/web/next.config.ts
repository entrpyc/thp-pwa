import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';

/**
 * The release the client was built from, for the `app_version` every analytics event carries
 * (docs/project/observability.md § 5.2). The tag when the checkout is at one — which a deployed
 * box always is (`verify:production`'s `release` check) — and the short commit otherwise.
 * `dev` when there is no git at all, which is what a tarball build would be.
 */
function appVersion(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build artefact.
  transpilePackages: ['@thp/shared', '@thp/db'],
  typedRoutes: false,
  serverExternalPackages: ['postgres', '@node-rs/argon2'],
  // Source maps for the client chunks, so a browser exception in PostHog's error tracking shows
  // the file and line it came from rather than a minified frame (observability.md § 5.6). The
  // maps are written beside the chunks at build time and **removed after upload** by
  // scripts/upload-sourcemaps.sh, which runs in the deploy between the build and the restart —
  // so a deployed box never serves them. A build nobody uploads from (a machine without the CLI
  // token) keeps its maps on disk, which is a local matter.
  productionBrowserSourceMaps: true,
  // Nothing in the app renders through `next/image`, so the `/_next/image` optimiser would only
  // ever be reached by somebody feeding it bytes of their own choosing — which is the surface the
  // 2026 image-optimisation advisories (AVIF, SVG, SSRF) were about. Off, so the route does not
  // exist rather than merely being unused (docs/security-audit-2026-10-28.md, finding 1).
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion(),
    // The one switch (.env.example, THP_MOCK_EXTERNAL) mirrored to the client bundle, so a
    // development build or a test run carries an analytics adapter that sends nothing — the same
    // promise the server-side adapters make. A value, not a decision: the client reads it through
    // the same `isExternalMocked` the server does.
    NEXT_PUBLIC_THP_MOCK_EXTERNAL: process.env.THP_MOCK_EXTERNAL ?? '',
  },
  async headers() {
    return [
      {
        // The browser-side hardening every response carries (security audit, finding 6). The
        // Content-Security-Policy is not here: it needs a per-request nonce for Next's inline
        // bootstrap scripts, so it is set by `src/proxy.ts`. HSTS is nginx's, because only the
        // process that terminates TLS knows the connection was secure (deploy/nginx/thp.conf).
        //
        // `X-Frame-Options` duplicates the CSP's `frame-ancestors` for the WebViews and older
        // browsers that read only the former. `Permissions-Policy` turns off the device features
        // nothing here uses, so a future injected script cannot ask for them either.
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
      {
        // Apple fetches this file with no extension and refuses it unless it is served as JSON;
        // Next would otherwise type it by extension and send an octet stream, and universal links
        // from the store shell would silently never open the app (packages/shell/README.md).
        // Google's assetlinks.json beside it has an extension and needs nothing.
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
};

export default config;
