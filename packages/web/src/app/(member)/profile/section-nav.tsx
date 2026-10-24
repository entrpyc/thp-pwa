'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PROFILE_PAGE_PATH } from '@thp/shared';
import { useBreadcrumbTrail } from '../player-context';
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
 *
 * It also names the page in the breadcrumb, because it is the one client component every page
 * under `/profile` renders and it already knows which section the address is in: *My profile* on
 * the identity page, and *My profile › Settings* (or whichever) on a section, with *My profile*
 * a link back to the root.
 */
export function ProfileSectionNav() {
  const pathname = usePathname();
  const current = sectionFor(pathname);
  const atRoot = current === null || current.href === PROFILE_PAGE_PATH;
  useBreadcrumbTrail(
    atRoot ? 'My profile' : current.label,
    atRoot ? [] : [{ label: 'My profile', href: PROFILE_PAGE_PATH }],
  );

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
