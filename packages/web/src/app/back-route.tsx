'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

/**
 * **The way back, anywhere in the app** — the chevron on a hero band, the *Back* under a public
 * document.
 *
 * **It goes where the member came from, when there is a where.** Somebody who opened a teaching
 * from a search wants the search; somebody who opened the privacy policy from the sign-in form
 * wants the sign-in form; and the only thing that knows which is the browser's history. So a plain
 * press steps back through it when there is an entry to step back to, and otherwise follows
 * `fallbackHref` — the place the page belongs to, for a member who arrived from a shared link and
 * has nothing of ours behind them.
 *
 * It is an `<a href>` underneath rather than a button, deliberately. The fallback is a real
 * destination, so the link works before hydration, reads correctly to a screen reader, and opens in
 * a new tab under a modifier key — which is why a modified click is left to the browser rather
 * than turned into a history step that would close nothing and open nothing.
 *
 * Whether there is an entry to step back to is the Navigation API's `canGoBack` where the browser
 * has it: it counts only this origin's contiguous entries, so a reader who arrived from an external
 * link or a fresh tab is sent to the fallback rather than stepped off the site. Where it is missing,
 * `history.length` stands in — coarser, since it counts entries across origins, but the only other
 * signal that survives client-side navigation, where `document.referrer` still names whatever opened
 * the first document.
 */

/** Whether a back press would land on one of our own pages. */
function canGoBack(): boolean {
  const navigation = (window as { navigation?: { canGoBack?: boolean } }).navigation;
  if (navigation !== undefined && typeof navigation.canGoBack === 'boolean') return navigation.canGoBack;
  return window.history.length > 1;
}
export function BackRoute({
  fallbackHref,
  className,
  children,
  ...rest
}: {
  readonly fallbackHref: string;
  /** `| undefined` because a CSS-module lookup is one, and the caller should not have to say so. */
  readonly className?: string | undefined;
  readonly 'aria-label'?: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();

  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modified || event.button !== 0) return;
    if (!canGoBack()) return;
    event.preventDefault();
    router.back();
  }

  return (
    <Link href={fallbackHref} onClick={onClick} {...(className === undefined ? {} : { className })} {...rest}>
      {children}
    </Link>
  );
}
