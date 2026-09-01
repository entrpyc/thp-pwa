import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { APP_BACKGROUND_COLOUR } from './app-theme';
import './tokens.css';
import './globals.css';
import { ServiceWorkerRegistration } from './service-worker-registration';

export const metadata = {
  title: 'Teaching Hub',
};

/**
 * **Installed-to-the-home-screen is a supported way to run the hub**, and both fields here are for
 * that case rather than for the browser.
 *
 * `themeColor` is what Android paints the status bar and the task-switcher header with, and it is
 * the token layer's `--color-bg`, so the system chrome continues the document rather than framing
 * it. `viewportFit: 'cover'` lets the document reach under the rounded corners and the home
 * indicator — a standalone window has no Safari toolbar keeping the transport bar clear of it, so
 * the bar pads itself with the safe-area inset that this unlocks.
 */
export const viewport: Viewport = {
  themeColor: APP_BACKGROUND_COLOUR,
  viewportFit: 'cover',
};

/**
 * The document, plus the two stylesheets every screen depends on: the token layer built from
 * docs/design-references/style-guide.md, and the document-level base composed from it.
 *
 * Still no navigation chrome — the top and bottom navigation have design references and arrive
 * with the steps that own them.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistration />
        {children}
      </body>
    </html>
  );
}
