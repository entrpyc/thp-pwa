import type { MetadataRoute } from 'next';
import { APP_BACKGROUND_COLOUR, APP_ICON } from './app-theme';

/**
 * **The web app manifest** — what makes the hub installable to a phone's home screen.
 *
 * Served at `/manifest.webmanifest` by the file convention, with the `<link>` injected into every
 * document; there is nothing to wire up in the layout.
 *
 * The two platforms want different things from this file, and both are here:
 *
 * - **Android** installs from the manifest alone, but Chrome only offers the install prompt when it
 *   finds a name, a `start_url`, a `display` other than `browser`, and both a 192px and a 512px
 *   icon — plus a service worker with a `fetch` handler, which is `public/sw.js`. A missing 512
 *   fails the check silently, so the sizes here are load-bearing rather than thorough.
 * - **iOS** never prompts. Safari reads `display` and `theme_color` when a member uses *Add to Home
 *   Screen*, which is what turns the launched hub into a standalone window rather than a tab; the
 *   icon it uses is `apple-icon.png` beside this file, not anything listed below.
 *
 * `maskable` is a separate entry rather than a `purpose` on the others because Android crops
 * maskable art to whatever shape the launcher uses — declaring one icon as both means the same
 * pixels get cropped in the launcher and padded in the task switcher, and one of the two looks
 * wrong. The maskable file draws its mark smaller to survive the crop.
 *
 * The colours are the token layer's `--color-bg` and are duplicated here because a manifest cannot
 * read CSS. `background_color` is the splash the launcher paints before the first render; keeping
 * it equal to the document background is what stops the launch flashing white.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Teaching Hub',
    short_name: 'Teaching Hub',
    description: 'Teachings, series and recordings.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: APP_BACKGROUND_COLOUR,
    theme_color: APP_BACKGROUND_COLOUR,
    icons: [
      { src: APP_ICON, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
