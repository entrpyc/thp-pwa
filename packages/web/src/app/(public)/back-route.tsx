'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/**
 * The way back from a public document.
 *
 * **It goes where the reader came from, when there is a where.** Somebody who opened the privacy
 * policy from the sign-in form wants the sign-in form; somebody who opened it from their profile
 * wants their profile; and the only thing that knows which is the browser's history. So a click
 * steps back through it when there is an entry to step back to, and otherwise follows `fallbackHref`
 * — the server's best answer, chosen by whether a session exists (public-document.tsx).
 *
 * It is an `<a href>` underneath rather than a button, deliberately. The fallback is a real
 * destination, so the link works before hydration, reads correctly to a screen reader, and opens in
 * a new tab under a modifier key — which is why a modified click is left to the browser rather
 * than turned into a history step that would close nothing and open nothing.
 *
 * `history.length` is a coarse signal — it counts entries across origins, so a reader who arrived
 * from an external link is stepped back off the site — but it is the only one that survives
 * client-side navigation, where `document.referrer` still names whatever opened the first document.
 */
export function BackRoute({
  fallbackHref,
  className,
  children,
}: {
  readonly fallbackHref: string;
  /** `| undefined` because a CSS-module lookup is one, and the caller should not have to say so. */
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const router = useRouter();

  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modified || event.button !== 0) return;
    if (window.history.length <= 1) return;
    event.preventDefault();
    router.back();
  }

  return (
    <Link href={fallbackHref} onClick={onClick} {...(className === undefined ? {} : { className })}>
      {children}
    </Link>
  );
}
