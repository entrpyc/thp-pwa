'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ADMIN_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  FEEDBACK_PAGE_PATH,
  MEMBER_LIBRARY_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  NEW_USER_ONBOARDING_ID,
  NOTIFICATIONS_PAGE_PATH,
  PROFILE_PAGE_PATH,
  onboardingPagePath,
} from '@thp/shared';
import { SignOutButton } from '../sign-out-button';
import { InstallApp } from './install-app';
import { useNotifications } from './notifications-context';
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
 * *Report a bug* is the one entry here that is not a destination in the product and not a
 * consequence of the reference images. It is in the menu rather than on a screen because a member
 * who has just hit something broken is, by definition, somewhere unexpected — and the menu is the
 * only control that is on every screen. It is offered unconditionally, for the same reason the
 * report route authorises nothing beyond *who*.
 *
 * The breadcrumb is home → every ancestor the page named, outermost first → the current page's
 * title. Each ancestor is a **link** rather than text: getting back up in one press is the whole of
 * what those segments are for. A page that names none renders exactly the two segments it always
 * did.
 *
 * How many there are is the page's business and not this component's. A teaching in a series names
 * one; a chapter names the series and then the teaching, so a member three levels down reads the
 * whole path rather than a trail that skipped a level to fit.
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

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * **The bell** ([3.17.2](docs/project/prd.md), [3.17.3](docs/project/prd.md)) — the way into the
 * centre, carrying the unread count. A link rather than a button that opens a panel: the centre is
 * a page, so it is reachable by URL, survives a reload, and reads on a phone as a screen rather
 * than as a popover fighting the menu for the same corner.
 *
 * The count is capped in print at ninety-nine — the label says the real number — because a badge
 * three digits wide stops being a badge.
 */
function Bell() {
  const { unreadCount } = useNotifications();
  const label =
    unreadCount === 0
      ? 'Notifications'
      : `Notifications, ${unreadCount} unread`;
  return (
    <Link className={styles.bellLink} href={NOTIFICATIONS_PAGE_PATH} aria-label={label}>
      <BellIcon />
      {unreadCount > 0 ? (
        <span className={styles.bellCount} aria-hidden="true">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      ) : null}
    </Link>
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
  const { ancestors, current } = useBreadcrumbTrailValue();
  const regionRef = useRef<HTMLDivElement>(null);

  /*
   * An open menu closes on a press anywhere outside it — the tap-away every member already expects
   * of a menu, and the only way out on touch, where there is no Escape. `pointerdown` rather than
   * `click`, so the menu is gone before the press lands on whatever was underneath it, and the
   * listeners exist only while the menu is open.
   */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && regionRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.navRegion} ref={regionRef}>
      <nav className={styles.navBar} aria-label="Breadcrumb">
        <ol className={styles.crumbs}>
          <li className={styles.crumb}>
            <Link className={styles.homeLink} href={DASHBOARD_PAGE_PATH} aria-label="Dashboard">
              <HomeIcon />
            </Link>
          </li>
          {/*
            Every ancestor the page named, outermost first — one segment for a teaching in a series,
            two for a chapter inside one. Keyed on the href rather than the index: a trail that grows
            a segment when the payload lands would otherwise re-key the ones already drawn.
          */}
          {ancestors.map((ancestor) => (
            <li className={styles.crumb} key={ancestor.href}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <Link className={styles.crumbLink} href={ancestor.href}>
                {ancestor.label}
              </Link>
            </li>
          ))}
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

        <div className={styles.navControls}>
          <Bell />
          <button
            className={styles.menuButton}
            type="button"
            aria-expanded={open}
            aria-label="Menu"
            onClick={() => setOpen((was) => !was)}
          >
            <MenuIcon />
          </button>
        </div>
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
            {/*
              The tour's own promise, kept: its last slide says "you can always come back to it
              later", and this is the way back. Replaying it changes nothing — the completion is
              already recorded, so finishing or skipping simply returns to the dashboard.
            */}
            <li>
              <Link
                className={styles.menuLink}
                href={onboardingPagePath(NEW_USER_ONBOARDING_ID)}
                onClick={() => setOpen(false)}
              >
                App tour
              </Link>
            </li>
            {/*
              Below the destinations and above the utilities, because it is neither: it is not a
              place in the product, and it is not something the browser or the session does. It is
              offered to everybody, on the same terms — a rule about who may say something is broken
              would be a rule about whose bugs count.
            */}
            <li>
              <Link
                className={styles.menuLink}
                href={FEEDBACK_PAGE_PATH}
                onClick={() => setOpen(false)}
              >
                Report a bug
              </Link>
            </li>
            <InstallApp className={styles.menuLink} hintClassName={styles.menuHint} />
            {/*
              The two things about an account that are its owner's to change
              ([3.1.12](docs/project/prd.md)) — the name others see and the picture beside it. After
              the destinations and before the console, because it is a place in the product that
              every member has and the console is one that most do not.
            */}
            <li>
              <Link className={styles.menuLink} href={PROFILE_PAGE_PATH} onClick={() => setOpen(false)}>
                My profile
              </Link>
            </li>
            <li className={styles.menuSignOut}>
              <SignOutButton className={styles.menuLink} />
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}
