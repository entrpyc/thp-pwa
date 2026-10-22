'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PROFILE_SECTIONS, sectionFor } from './sections';
import styles from './profile.module.css';

/**
 * **The section strip** — one pill per entry in `PROFILE_SECTIONS`, the current one marked.
 *
 * It renders from the list and nothing else: it has no opinion about which sections exist, so a
 * ticket adding one never opens this file. The pills are links rather than tabs, because each is a
 * page with its own address — the browser's back button and a bookmark both work — and the
 * recording page's tab recipe is reused for the look, so the two strips read as one family.
 *
 * `aria-current` is read off the address rather than held in state, so a hard load of
 * `/profile/settings` marks Settings as surely as a press does.
 */
export function ProfileSectionNav() {
  const pathname = usePathname();
  const current = sectionFor(pathname);

  return (
    <nav aria-label="Profile sections">
      <ul className={styles.sectionList}>
        {PROFILE_SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              className={styles.sectionLink}
              href={section.href}
              {...(section.id === current?.id ? { 'aria-current': 'page' as const } : {})}
            >
              {section.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
