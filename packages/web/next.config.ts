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
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion(),
    // The one switch (.env.example, THP_MOCK_EXTERNAL) mirrored to the client bundle, so a
    // development build or a test run carries an analytics adapter that sends nothing — the same
    // promise the server-side adapters make. A value, not a decision: the client reads it through
    // the same `isExternalMocked` the server does.
    NEXT_PUBLIC_THP_MOCK_EXTERNAL: process.env.THP_MOCK_EXTERNAL ?? '',
  },
};

export default config;
