import type { ReactNode } from 'react';
import './tokens.css';
import './globals.css';

export const metadata = {
  title: 'Teaching Hub',
};

/**
 * The document, plus the two stylesheets every screen depends on: the token layer built from
 * docs/design referencess png/style-guide.md, and the document-level base composed from it.
 *
 * Still no navigation chrome — the top and bottom navigation have design references and arrive
 * with the steps that own them.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
