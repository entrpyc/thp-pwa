'use client';

import Link from 'next/link';
import { NOTIFICATION_KIND_LABEL, type NotificationView } from '@thp/shared';
import { useNotifications } from '../notifications-context';
import { useBreadcrumbTrail } from '../player-context';
import styles from './notifications.module.css';

/**
 * **The notification centre** ([3.17.2](docs/project/prd.md), [3.17.3](docs/project/prd.md)) —
 * every event this member was told about, newest first, and a press on one that takes them to
 * what it is about.
 *
 * Three rules:
 *
 * 1. **A row with a destination is a link, and pressing it marks it read on the way.** The mark is
 *    sent and not awaited: the member asked to go somewhere, and a slow write should not hold the
 *    door. If the write fails the row stays unread, which is the honest state.
 * 2. **A row with no destination — an admin announcement — is its own content.** Pressing it
 *    marks it read and nothing else, because there is nowhere else the message lives.
 * 3. **Unread is said by weight and a dot, never by hue.** The one accent on the page is the dot,
 *    which is the same accent the bell's badge carries.
 */

function formatWhen(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function NotificationsCentre() {
  useBreadcrumbTrail('Notifications');
  const { notifications, unreadCount, failed, markRead, markAllRead } = useNotifications();

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Notifications</h1>
        <p className={styles.pageLead}>
          New recordings, replies and reactions to your notes, and what the group has been told.
        </p>
      </header>

      {unreadCount > 0 ? (
        <div className={styles.toolbar}>
          <button className={styles.readAll} type="button" onClick={() => void markAllRead()}>
            Mark all as read
          </button>
        </div>
      ) : null}

      {failed && notifications === null ? (
        <p className={styles.failure} role="alert">
          Could not load your notifications. Reload the page to try again.
        </p>
      ) : notifications === null ? (
        <p className={styles.quiet}>Loading…</p>
      ) : notifications.length === 0 ? (
        <p className={styles.quiet}>Nothing yet. When something happens, it will be listed here.</p>
      ) : (
        <ul className={styles.rows} aria-label="Notifications">
          {notifications.map((entry) => (
            <li className={styles.rowGroup} key={entry.id}>
              <Row entry={entry} onRead={markRead} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Row({
  entry,
  onRead,
}: {
  entry: NotificationView;
  onRead: (id: string) => Promise<void>;
}) {
  const unread = entry.readAt === null;
  const className = unread ? `${styles.row} ${styles.rowUnread}` : styles.row;

  const content = (
    <>
      <span className={styles.rowDot} aria-hidden="true" />
      <span className={styles.rowText}>
        <span className={styles.rowKind}>{NOTIFICATION_KIND_LABEL[entry.kind]}</span>
        <span className={styles.rowTitle}>{entry.title}</span>
        {entry.body === '' ? null : <span className={styles.rowBody}>{entry.body}</span>}
        <span className={styles.rowMeta}>
          {formatWhen(entry.createdAt)}
          {unread ? ' · unread' : ''}
        </span>
      </span>
      {entry.href === null ? null : (
        <span className={styles.rowChevron} aria-hidden="true">
          ›
        </span>
      )}
    </>
  );

  if (entry.href !== null) {
    return (
      <Link
        className={className}
        href={entry.href}
        onClick={() => {
          if (unread) void onRead(entry.id).catch(() => undefined);
        }}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      className={className}
      type="button"
      aria-pressed={!unread}
      onClick={() => {
        if (unread) void onRead(entry.id).catch(() => undefined);
      }}
    >
      {content}
    </button>
  );
}
