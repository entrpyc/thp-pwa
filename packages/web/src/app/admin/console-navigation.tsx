'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { DASHBOARD_PAGE_PATH } from '@thp/shared';
import { SignOutButton } from '../sign-out-button';
import styles from './admin.module.css';

/**
 * The console's side menu: the brand, the panel list, and who is signed in with the ways out.
 *
 * One block of markup for every width. On a desktop it is a column down the left of the screen,
 * always open; on a phone the brand line becomes a top bar with a burger button, and the panel
 * list and the identity fold into a drawer under it. The stylesheet decides which of the two is
 * seen — nothing here is rendered twice, so there is one `h1`, one `nav` and one *Sign out* on the
 * page however it is measured.
 *
 * A client module only for the one piece of state a phone needs: whether the drawer is open. The
 * drawer closes on a press outside it, on Escape, and on choosing a panel, which is what every
 * member already expects of the menu on the member screens.
 */

export interface ConsolePanelLink {
  readonly id: string;
  readonly href: string;
  readonly label: string;
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ConsoleNavigation({
  panels,
  current,
  displayName,
  email,
}: {
  panels: readonly ConsolePanelLink[];
  current: string;
  displayName: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const regionRef = useRef<HTMLElement>(null);

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
    <aside className={styles.sidebar} data-open={open ? 'true' : 'false'} ref={regionRef}>
      <div className={styles.brand}>
        <div className={styles.brandText}>
          <p className={styles.eyebrow}>Vinegard</p>
          <h1 className={styles.title}>Admin console</h1>
        </div>
        <button
          className={styles.menuButton}
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? <CloseIcon /> : <MenuIcon />}
        </button>
      </div>

      <div className={styles.drawer} id={drawerId}>
        <nav className={styles.panels} aria-label="Console panels">
          <ul className={styles.panelList}>
            {panels.map((panel) => (
              <li key={panel.id}>
                <a
                  className={styles.panelLink}
                  href={panel.href}
                  onClick={() => setOpen(false)}
                  {...(panel.id === current ? { 'aria-current': 'page' as const } : {})}
                >
                  {panel.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.identity}>
          <p className={styles.identityName}>{displayName}</p>
          <p className={styles.identityEmail}>{email}</p>
          {/*
            **The way back.** The member navigation offers the console; nothing offered the
            member surface in return, so an operator who came here to publish a teaching had to
            type the root to go and listen to it. It sits with sign-out rather than among the
            panels: the panel list is the things this console *is*, and the dashboard is not one
            of them — an entry there would read as a panel that never takes the current mark.
          */}
          <div className={styles.identityLinks}>
            <a className={styles.identityLink} href={DASHBOARD_PAGE_PATH}>
              Dashboard
            </a>
            <SignOutButton />
          </div>
        </div>
      </div>
    </aside>
  );
}
