import type { ReactNode } from 'react';
import {
  ADMIN_PAGE_PATH,
  ADMIN_PIPELINE_PAGE_PATH,
  ADMIN_RECORDINGS_PAGE_PATH,
  ADMIN_REVIEWS_PAGE_PATH,
} from '@thp/shared';
import type { Actor } from '@/server/auth/policy';
import { SignOutButton } from '../sign-out-button';
import styles from './admin.module.css';

/**
 * The console's chrome: who is signed in, the way out, and the list of panels.
 *
 * Extracted when the second panel arrived (Story 2 Ticket 01). The shell was always described as
 * "a layout and a panel list, not a registry" — one entry today, a later panel is a file and a line
 * in the list. This is that line, and lifting the header out is what stops the two pages having two
 * headers that can drift.
 *
 * **It is not a gate.** Each page decides what it renders by asking the policy module before it
 * renders anything, and every row any of them shows comes from an API route that refuses a member
 * independently.
 */

/** The panels, in the order they are read. A fifth is one entry — the fourth was. */
const PANELS = [
  { id: 'users', href: ADMIN_PAGE_PATH, label: 'User management' },
  { id: 'recordings', href: ADMIN_RECORDINGS_PAGE_PATH, label: 'Recordings' },
  { id: 'pipeline', href: ADMIN_PIPELINE_PAGE_PATH, label: 'Pipeline' },
  { id: 'reviews', href: ADMIN_REVIEWS_PAGE_PATH, label: 'Pending Reviews' },
] as const;

export type PanelId = (typeof PANELS)[number]['id'];

export function ConsoleShell({
  actor,
  current,
  children,
}: {
  actor: Actor;
  current: PanelId;
  children: ReactNode;
}) {
  return (
    <main className={styles.screen}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Teaching Hub</p>
            <h1 className={styles.title}>Admin console</h1>
          </div>
          <div className={styles.identity}>
            <p className={styles.identityName}>{actor.displayName}</p>
            <p className={styles.identityEmail}>{actor.email}</p>
            <SignOutButton />
          </div>
        </header>

        <nav className={styles.panels} aria-label="Console panels">
          <ul className={styles.panelList}>
            {PANELS.map((panel) => (
              <li key={panel.id}>
                <a
                  className={styles.panelLink}
                  href={panel.href}
                  {...(panel.id === current ? { 'aria-current': 'page' as const } : {})}
                >
                  {panel.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {children}
      </div>
    </main>
  );
}
