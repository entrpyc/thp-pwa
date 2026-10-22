import type { CapacitorConfig } from '@capacitor/cli';

/**
 * **The store shell is a window onto the live site, not a copy of it** (docs/project/tdd.md
 * decision 4.3; project prd 5.2.2, 5.2.4). The web app is server-rendered Next.js with API
 * routes, so there is no static build to bundle: `server.url` points the WebView at the deployed
 * origin, `www/` holds a single explanatory page, and a feature release reaches the shell the
 * moment it reaches the browser — without a store review.
 *
 * `THP_SHELL_SERVER_URL` overrides the origin for a build that should load a development server
 * (packages/shell/README.md). Read at `cap sync` time: the value is baked into the native
 * projects' `capacitor.config.json`, so the override has to be set when syncing, not when running.
 */
const PRODUCTION_ORIGIN = 'https://thp.indepthwebsolutions.com';

const serverUrl = (process.env.THP_SHELL_SERVER_URL ?? '').trim() || PRODUCTION_ORIGIN;

const config: CapacitorConfig = {
  appId: 'com.indepthwebsolutions.teachinghub',
  appName: 'Teaching Hub',
  webDir: 'www',
  server: {
    url: serverUrl,
    // Android refuses plain-HTTP page loads unless told otherwise. Only a development override can
    // be `http://`, so cleartext follows the scheme rather than being switched on for every build —
    // the production shell keeps the platform's HTTPS-only default.
    cleartext: serverUrl.startsWith('http://'),
    // No `allowNavigation`: only the app's own origin renders inside the WebView. A link to another
    // host — Spotify, a Bible source, anything in an email — opens in the system browser, where
    // the member has a URL bar and a way back.
  },
};

export default config;
