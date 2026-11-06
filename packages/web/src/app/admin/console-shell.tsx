import type { ReactNode } from 'react';
import {
  ADMIN_ANNOUNCEMENTS_PAGE_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_PIPELINE_PAGE_PATH,
  ADMIN_RECORDINGS_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_REVIEWS_PAGE_PATH,
  ADMIN_SERIES_PAGE_PATH,
  ADMIN_SOUND_PROFILE_PAGE_PATH,
  ADMIN_TAGS_PAGE_PATH,
} from '@thp/shared';
import type { Actor } from '@/server/auth/policy';
import { ConsoleNavigation } from './console-navigation';
import styles from './admin.module.css';

/**
 * The console's chrome: who is signed in, the ways out, and the list of panels — a side menu on a
 * desktop, a top bar with a burger on a phone (`console-navigation.tsx`), and the panel beside or
 * under it.
 *
 * Extracted when the second panel arrived (Story 2 Ticket 01). The shell was always described as
 * "a layout and a panel list, not a registry" — one entry today, a later panel is a file and a line
 * in the list. This is that line, and lifting the chrome out is what stops the pages having
 * headers that can drift.
 *
 * **It is not a gate.** Each page decides what it renders by asking the policy module before it
 * renders anything, and every row any of them shows comes from an API route that refuses a member
 * independently.
 */

/** The panels, in the order they are read. The ninth is one entry — as the eighth was. */
const PANELS = [
  { id: 'users', href: ADMIN_PAGE_PATH, label: 'User management' },
  { id: 'recordings', href: ADMIN_RECORDINGS_PAGE_PATH, label: 'Recordings' },
  { id: 'pipeline', href: ADMIN_PIPELINE_PAGE_PATH, label: 'Pipeline' },
  { id: 'sound-profile', href: ADMIN_SOUND_PROFILE_PAGE_PATH, label: 'Sound profile' },
  { id: 'reviews', href: ADMIN_REVIEWS_PAGE_PATH, label: 'Pending Reviews' },
  { id: 'series', href: ADMIN_SERIES_PAGE_PATH, label: 'Series' },
  { id: 'tags', href: ADMIN_TAGS_PAGE_PATH, label: 'Tags' },
  { id: 'announcements', href: ADMIN_ANNOUNCEMENTS_PAGE_PATH, label: 'Announcements' },
  { id: 'reports', href: ADMIN_REPORTS_PAGE_PATH, label: 'Reports' },
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
        <ConsoleNavigation
          panels={PANELS}
          current={current}
          displayName={actor.displayName}
          email={actor.email}
        />
        <div className={styles.content}>{children}</div>
      </div>
    </main>
  );
}
