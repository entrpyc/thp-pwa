import type { ReactNode } from 'react';
import styles from './public.module.css';

/**
 * **The public surface** — every page somebody can reach without a session.
 *
 * A route group rather than a path segment, for the same reason `(member)` is one: `/sign-in`,
 * `/sign-up` and the rest keep the URLs they have always had, and `(public)` exists only so they
 * share a shell. The shell is the centred card stage the auth screens have drawn since the first
 * one — one `<main>` filling the viewport with whatever the page renders held in its middle — and
 * it used to be restated by every page. Now it is stated once, here, and a page under this group
 * renders only its card.
 *
 * **Being public is a matter of position, not of this layout.** The member group's layout is what
 * turns a missing session into a redirect; this one reads no session and redirects nobody, so a
 * page lands here by being placed here. What a page does *with* a session is its own decision —
 * sign-in sends a signed-in visitor on, forgot-password is deliberately reachable either way, and
 * a long-form document (see public-document.tsx) only changes where its way back leads. None of
 * that belongs in a layout that would then have to know every page's answer.
 *
 * API routes are a separate question with a separate answer: a route is public only when
 * `server/auth/allowlist.ts` lists it, whatever directory it sits in.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <main className={styles.screen}>{children}</main>;
}
