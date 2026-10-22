import type { ReactNode } from 'react';
import { ProfileSectionNav } from './section-nav';
import styles from './profile.module.css';

/**
 * **The profile's chrome** — the heading and the section strip every page under `/profile` shares.
 *
 * A nested layout rather than a header each page repeats, so that `/profile`, `/profile/settings`
 * and every section after them are one place with several pages: the `<h1>` reads *My profile* on
 * all of them, the strip beneath it says where in that place the member is, and a page below adds
 * only its own `<h2>` and its cards. Nothing here reads the session — the member layout above has
 * already refused an anonymous visitor, and each page's writes answer with the user they render
 * from.
 */
export default function ProfileLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>My profile</h1>
        <ProfileSectionNav />
      </header>
      {children}
    </>
  );
}
