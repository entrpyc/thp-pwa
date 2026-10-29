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
    //
    // When the origin cannot be loaded — no network, a captive portal, the server down — the
    // WebView shows this page of ours instead of its own error page. It lives in `www/` beside
    // the placeholder index, is styled like the product, and retries on its own when connectivity
    // returns. On Android the file runs without Capacitor plugins (the documented limit), which
    // is why its retry is a plain navigation back to the origin.
    errorPath: 'offline.html',
  },
  plugins: {
    // A push that arrives while the app is open is still shown by the OS (project prd 3.17.1):
    // without this iOS swallows foreground pushes, and a member reading one teaching would never
    // learn of a reply on another until the bell polled. The web app refreshes the bell on the
    // same event (push-shell-listener.tsx), so both happen.
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
    // Android 15+ draws edge-to-edge for an app targeting API 35+ (variables.gradle targets 36).
    // `css` is Capacitor 8's default and is named here so it is a decision rather than a default:
    // the WebView follows the document's `viewport-fit=cover` (packages/web/src/app/layout.tsx),
    // so `env(safe-area-inset-*)` carries the real status-bar and gesture-bar heights and the web
    // app's own padding — the top bar and the transport bar already read those insets for the
    // installed PWA — keeps the chrome clear of the system bars on both platforms.
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
