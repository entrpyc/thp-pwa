import type { ReactNode } from 'react';

export const metadata = {
  title: 'Teaching Hub',
};

/**
 * The bare document Next.js needs in order to boot. **No page is designed in this step** — the
 * first designed screen arrives with the step that owns it, built from its reference PNG.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
