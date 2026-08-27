'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ADMIN_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
} from '@thp/shared';
import { SignOutButton } from '../sign-out-button';
import { InstallApp } from './install-app';
import { useBreadcrumbTrailValue } from './player-context';
import styles from './member.module.css';

/**
 * **The top navigation** — `top-navigation/default.png` and `top-navigation/menu-opened.png`.
 *
 * One dark rounded bar: home icon, chevron separators, the current item in the accent, and the menu
 * boxed on the right. What the references show and this does **not** render is the point of the
 * component:
 *
 * - **No search control.** [§3.10](docs/project/prd.md) is deferred whole, and a magnifier that
 *   opened nothing would be a promise this epic cannot keep.
 * - **No *All chapters*.** Chapters have no model in this epic at all. *All series* **arrived in
 *   Story 6** and sits where the reference puts it — between *Dashboard* and *All recordings* —
 *   which is what the dropped-not-disabled rule buys: a destination lands in a slot that already
 *   exists rather than needing one carved for it.
 * - **Nothing disabled.** A greyed control is a thing the next epic has to find and un-disable, and
 *   in the meantime it tells a member the product is broken rather than unfinished. A deferred
 *   destination is **dropped**, and what survives is the layout, the tone and the token layer — so
 *   the missing entries drop into slots that already exist.
 *
 * The *Admin console* entry is rendered from the policy module's answer and **grants nothing**:
 * `/admin` gates itself server-side and every route behind it refuses independently
 * ([3.1.5](docs/project/prd.md)).
 *
 * The breadcrumb is home → an optional parent → the current page's title. The parent is the series
 * segment `top-navigation/default.png` draws, inserted in Story 6, and it is a **link** rather than
 * text: getting back to the series in one press is the whole of what the segment is for. A page
 * with no parent renders exactly the two segments it always did.
 */

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M4 7h16M4 12h16M4 17h16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TopNavigation({ canSeeConsole }: { canSeeConsole: boolean }) {
  const [open, setOpen] = useState(false);
  const { parent, current } = useBreadcrumbTrailValue();

  return (
    <div className={styles.navRegion}>
      <nav className={styles.navBar} aria-label="Breadcrumb">
        <ol className={styles.crumbs}>
          <li className={styles.crumb}>
            <Link className={styles.homeLink} href={DASHBOARD_PAGE_PATH} aria-label="Dashboard">
              <HomeIcon />
            </Link>
          </li>
          {parent === null ? null : (
            <li className={styles.crumb}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <Link className={styles.crumbLink} href={parent.href}>
                {parent.label}
              </Link>
            </li>
          )}
          {current === null ? null : (
            <li className={styles.crumb}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <span className={styles.crumbCurrent} aria-current="page">
                {current}
              </span>
            </li>
          )}
        </ol>

        <button
          className={styles.menuButton}
          type="button"
          aria-expanded={open}
          aria-label="Menu"
          onClick={() => setOpen((was) => !was)}
        >
          <MenuIcon />
        </button>
      </nav>

      {open ? (
        <div className={styles.menuPanel}>
          <ul className={styles.menuList} aria-label="Navigation">
            <li>
              <Link className={styles.menuLink} href={DASHBOARD_PAGE_PATH} onClick={() => setOpen(false)}>
                Dashboard
              </Link>
            </li>
            {/* Between Dashboard and All recordings, exactly where `menu-opened.png` draws it. */}
            <li>
              <Link
                className={styles.menuLink}
                href={MEMBER_SERIES_PAGE_PATH}
                onClick={() => setOpen(false)}
              >
                All series
              </Link>
            </li>
            <li>
              <Link
                className={styles.menuLink}
                href={MEMBER_LIBRARY_PAGE_PATH}
                onClick={() => setOpen(false)}
              >
                All recordings
              </Link>
            </li>
            {canSeeConsole ? (
              <li>
                <Link className={styles.menuLink} href={ADMIN_PAGE_PATH} onClick={() => setOpen(false)}>
                  Admin console
                </Link>
              </li>
            ) : null}
            <InstallApp className={styles.menuLink} hintClassName={styles.menuHint} />
            <li className={styles.menuSignOut}>
              <SignOutButton className={styles.menuLink} />
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
