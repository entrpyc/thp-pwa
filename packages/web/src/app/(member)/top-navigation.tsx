'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ADMIN_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  FEEDBACK_PAGE_PATH,
  HIGHLIGHTS_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  MY_NOTES_PAGE_PATH,
  NEW_USER_ONBOARDING_ID,
  NOTIFICATIONS_PAGE_PATH,
  PROFILE_PAGE_PATH,
  SEARCH_PAGE_PATH,
  onboardingPagePath,
} from '@thp/shared';
import { SignOutButton } from '../sign-out-button';
import { useNotifications } from './notifications-context';
import { useBreadcrumbTrailValue, type BreadcrumbKind } from './player-context';
import styles from './member.module.css';

/**
 * **The top navigation** — `top-navigation/default.png` and `top-navigation/menu-opened.png`.
 *
 * One dark rounded bar: home icon, chevron separators, the current item in the accent, and the
 * magnifier and the menu boxed on the right. What the references show and this does **not** render
 * is the point of the component:
 *
 * - **The search control arrived with [§3.10](docs/project/prd.md)** — `top-navigation/search.png`.
 *   The reference draws the magnifier opening a second bar under the first; here the magnifier is
 *   a **link to the search page**, where the box, the filters and the results all are. A bar that
 *   dropped down over the page was a second search box that did less than the page's own — no
 *   filters, nothing searched until Enter — and one more panel for the menu to fight with under
 *   the bar. A way to the search from every screen is [3.10.1](docs/project/prd.md)'s "from
 *   anywhere in the app", and a link is one that survives a reload and opens in a new tab.
 * - **No *All chapters*, and no *All recordings* any more.** Chapters have no model in this epic
 *   at all, and the library page went by the operator's decision — the series pages are the way to
 *   a teaching. *All series* **arrived in Story 6** and now leads the destinations — which is what
 *   the dropped-not-disabled rule buys: a destination lands in a slot that already exists rather
 *   than needing one carved for it.
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
 * what those segments are for — and a link always shows its page's title, at every width, because
 * a member choosing where to go back to has to be able to read the choices. Only the current
 * segment, which goes nowhere, folds to an icon on a phone. A page that names none renders exactly
 * the two segments it always did.
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

/**
 * **The current segment's icon, for the narrow bar** — a study, a teaching, a chapter — in the home
 * icon's line style. Drawn beside the title always; the stylesheet decides which of the two is seen.
 */
function CrumbIcon({ kind }: { kind: BreadcrumbKind }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' as const };
  return (
    <svg className={styles.crumbIcon} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {kind === 'series' ? (
        // A stack: the study's recordings, one behind another.
        <>
          <rect x="4" y="9" width="16" height="11" rx="1.5" {...stroke} />
          <path d="M7 6h10M9 3h6" {...stroke} strokeLinecap="round" />
        </>
      ) : kind === 'recording' ? (
        // A microphone: one teaching.
        <>
          <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" {...stroke} strokeLinecap="round" />
        </>
      ) : (
        // A bookmark: one chapter of it.
        <path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z" {...stroke} />
      )}
    </svg>
  );
}

/** The current segment's words, beside its icon when it has one. */
function CrumbText({ label, kind }: { label: string; kind: BreadcrumbKind | null }) {
  return (
    <>
      {kind === null ? null : <CrumbIcon kind={kind} />}
      <span className={kind === null ? undefined : styles.crumbLabel}>{label}</span>
    </>
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
  const { ancestors, current, currentKind } = useBreadcrumbTrailValue();
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
            two for a chapter inside one — each by its page's title. Keyed on the href rather than
            the index: a trail that grows a segment when the payload lands would otherwise re-key
            the ones already drawn.
          */}
          {ancestors.map((ancestor) => (
            <li className={styles.crumb} key={ancestor.href}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <Link className={styles.crumbLink} href={ancestor.href}>
                <span className={styles.crumbLabel}>{ancestor.label}</span>
              </Link>
            </li>
          ))}
          {current === null ? null : (
            <li className={styles.crumb}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <span
                className={`${styles.crumbCurrent}${currentKind === null ? '' : ` ${styles.crumbIconic}`}`}
                aria-current="page"
              >
                <CrumbText label={current} kind={currentKind} />
              </span>
            </li>
          )}
        </ol>

        <div className={styles.navControls}>
          {/*
            The magnifier, where `search.png` boxes it: left of the menu, the bell's own shape, and
            like the bell a link to a page — the search page, where the box and the results are.
          */}
          <Link className={styles.searchLink} href={SEARCH_PAGE_PATH} aria-label="Search">
            <SearchIcon />
          </Link>
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
            {/*
              The member's own two places first — notes, then highlights — by the operator's
              decision, ahead of the destinations. No *Dashboard* or *Flow Tracker* here: the home
              icon at the bar's left is the way to the dashboard from every screen, and the
              dashboard's tile is the way to the Flow Tracker.
            */}
            <li>
              <Link className={styles.menuLink} href={MY_NOTES_PAGE_PATH} onClick={() => setOpen(false)}>
                My notes
              </Link>
            </li>
            <li>
              <Link className={styles.menuLink} href={HIGHLIGHTS_PAGE_PATH} onClick={() => setOpen(false)}>
                My highlights
              </Link>
            </li>
            <li>
              <Link
                className={styles.menuLink}
                href={MEMBER_SERIES_PAGE_PATH}
                onClick={() => setOpen(false)}
              >
                All series
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
