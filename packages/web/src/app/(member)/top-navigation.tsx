'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ADMIN_PAGE_PATH,
  DASHBOARD_PAGE_PATH,
  FEEDBACK_PAGE_PATH,
  HIGHLIGHTS_PAGE_PATH,
  MAX_SEARCH_QUERY_LENGTH,
  MEMBER_LIBRARY_PAGE_PATH,
  MEMBER_SERIES_PAGE_PATH,
  NEW_USER_ONBOARDING_ID,
  NOTIFICATIONS_PAGE_PATH,
  PROFILE_PAGE_PATH,
  onboardingPagePath,
  searchPagePath,
} from '@thp/shared';
import { SignOutButton } from '../sign-out-button';
import { InstallApp } from './install-app';
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
 *   The magnifier opens a second bar under the first, the reference's own shape: magnifier, the
 *   query, a clear control at the right. Enter goes to the results page; nothing is searched until
 *   then, because every search is one provider call and the operator chose a search that runs on
 *   Enter over one that runs on every pause in typing. The reference also draws a preview result
 *   and *View all results* under the box, and that is what the Enter-only decision drops: the box
 *   here is a way to the results page, and the page is where results are. A search box on every
 *   screen is [3.10.1](docs/project/prd.md)'s "from anywhere in the app".
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

/**
 * **A segment's icon, for the narrow bar** — a study, a teaching, a chapter — in the home icon's
 * line style. Drawn beside the title always; the stylesheet decides which of the two is seen.
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

/** A segment's words, beside its icon when it has one. */
function CrumbText({ label, kind }: { label: string; kind: BreadcrumbKind | undefined }) {
  return (
    <>
      {kind === undefined ? null : <CrumbIcon kind={kind} />}
      <span className={kind === undefined ? undefined : styles.crumbLabel}>{label}</span>
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

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * **The search bar** — `top-navigation/search.png`'s second bar, drawn under the first while the
 * magnifier is open. One field, submitted on Enter to the results page; the clear control at the
 * right empties the field when it holds something and closes the bar when it does not, which is
 * the two things an × on a search field means.
 *
 * The field is focused the moment the bar opens, because a member who pressed a magnifier has
 * said what they want to do next. Escape closes it, as it closes the menu.
 */
function SearchBar({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed === '') return;
    router.push(searchPagePath({ query: trimmed }));
    onClose();
  }

  return (
    <form className={styles.searchBar} role="search" onSubmit={submit}>
      <span className={styles.searchGlyph} aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        ref={fieldRef}
        className={styles.searchField}
        type="search"
        name="q"
        aria-label="Search the library"
        placeholder="Search the library"
        value={query}
        maxLength={MAX_SEARCH_QUERY_LENGTH}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(event) => setQuery(event.target.value)}
      />
      <button
        className={styles.searchClear}
        type="button"
        aria-label={query === '' ? 'Close search' : 'Clear search'}
        onClick={() => {
          if (query === '') {
            onClose();
          } else {
            setQuery('');
            fieldRef.current?.focus();
          }
        }}
      >
        <ClearIcon />
      </button>
    </form>
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
  const [searching, setSearching] = useState(false);
  const { ancestors, current, currentKind } = useBreadcrumbTrailValue();
  const regionRef = useRef<HTMLDivElement>(null);

  /*
   * An open menu closes on a press anywhere outside it — the tap-away every member already expects
   * of a menu, and the only way out on touch, where there is no Escape. `pointerdown` rather than
   * `click`, so the menu is gone before the press lands on whatever was underneath it, and the
   * listeners exist only while the menu is open.
   *
   * The search bar closes the same two ways, for the same reasons — and the two are one effect
   * because they are one behaviour: whatever the bar has open goes away on a press elsewhere.
   */
  useEffect(() => {
    if (!open && !searching) return;

    function closeAll() {
      setOpen(false);
      setSearching(false);
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && regionRef.current?.contains(target)) return;
      closeAll();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeAll();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, searching]);

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
                <CrumbText label={ancestor.label} kind={ancestor.kind} />
              </Link>
            </li>
          ))}
          {current === null ? null : (
            <li className={styles.crumb}>
              <span className={styles.separator} aria-hidden="true">
                ›
              </span>
              <span className={styles.crumbCurrent} aria-current="page">
                <CrumbText label={current} kind={currentKind ?? undefined} />
              </span>
            </li>
          )}
        </ol>

        <div className={styles.navControls}>
          {/*
            The magnifier, where `search.png` boxes it: left of the menu, the bell's own shape. A
            toggle — pressing it again closes the bar — and opening it closes the menu, so the two
            panels never hang under the bar at once.
          */}
          <button
            className={styles.searchButton}
            type="button"
            aria-expanded={searching}
            aria-label="Search"
            onClick={() => {
              setSearching((was) => !was);
              setOpen(false);
            }}
          >
            <SearchIcon />
          </button>
          <Bell />
          <button
            className={styles.menuButton}
            type="button"
            aria-expanded={open}
            aria-label="Menu"
            onClick={() => {
              setOpen((was) => !was);
              setSearching(false);
            }}
          >
            <MenuIcon />
          </button>
        </div>
      </nav>

      {searching ? <SearchBar onClose={() => setSearching(false)} /> : null}

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
            {/* The member's own playlist (3.15.5) — its own page since the operator moved it out of the profile. */}
            <li>
              <Link className={styles.menuLink} href={HIGHLIGHTS_PAGE_PATH} onClick={() => setOpen(false)}>
                Highlights
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
