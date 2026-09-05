'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  notificationReadPath,
  type NotificationListPayload,
  type NotificationReadPayload,
  type NotificationView,
  type NotificationsReadAllPayload,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';

/**
 * **What the bell and the centre both read** ([3.17.2](docs/project/prd.md),
 * [3.17.3](docs/project/prd.md)).
 *
 * One fetch, two readers. The bell in the navigation prints the unread count and the centre lists
 * the rows, and both come from the same payload — so a press in the centre that marks one read is
 * the same event that takes one off the bell, with no second request and no two numbers to keep in
 * step.
 *
 * **When it re-reads.** On mount; on every navigation, because a member who has just published or
 * replied is the member most likely to be told something next; when the tab comes back into view,
 * because a phone that was in a pocket for an hour has missed a morning; and every minute while
 * the tab is open, which is the cheapest honest answer to "how fresh is the bell" without a push
 * channel. Nothing here retries a failure — the next trigger is never far away.
 */

const POLL_MS = 60_000;

export interface NotificationsApi {
  /** The rows the centre lists, newest first, or `null` before the first read lands. */
  readonly notifications: readonly NotificationView[] | null;
  /** What the bell prints. Zero before the first read, so the bell never shows a stale number. */
  readonly unreadCount: number;
  /** Whether the last read failed. The bell stays quiet; the centre says so. */
  readonly failed: boolean;
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

const NotificationsContext = createContext<NotificationsApi | null>(null);

export function useNotifications(): NotificationsApi {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error('useNotifications used outside the member layout');
  return value;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [notifications, setNotifications] = useState<readonly NotificationView[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [failed, setFailed] = useState(false);

  // A read that lands after a later one started must not overwrite it. Each read takes a ticket
  // and only the latest ticket is allowed to write.
  const ticket = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++ticket.current;
    try {
      const payload = await apiFetch<NotificationListPayload>(NOTIFICATIONS_PATH, {
        credentials: 'include',
      });
      if (mine !== ticket.current) return;
      setNotifications(payload.notifications);
      setUnreadCount(payload.unreadCount);
      setFailed(false);
    } catch {
      if (mine !== ticket.current) return;
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    function onVisible(): void {
      if (document.visibilityState === 'visible') void refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const markRead = useCallback(async (id: string): Promise<void> => {
    const payload = await apiFetch<NotificationReadPayload>(notificationReadPath(id), {
      method: 'PUT',
      credentials: 'include',
    });
    // Adopt the server's answer rather than guessing: the row as it now reads, and the count it
    // computed over every row rather than over the page this client happens to hold.
    setNotifications((held) =>
      held === null
        ? held
        : held.map((one) => (one.id === id ? payload.notification : one)),
    );
    setUnreadCount(payload.unreadCount);
  }, []);

  const markAllRead = useCallback(async (): Promise<void> => {
    const payload = await apiFetch<NotificationsReadAllPayload>(NOTIFICATIONS_READ_ALL_PATH, {
      method: 'PUT',
      credentials: 'include',
    });
    const now = new Date().toISOString();
    setNotifications((held) =>
      held === null ? held : held.map((one) => (one.readAt === null ? { ...one, readAt: now } : one)),
    );
    setUnreadCount(payload.unreadCount);
  }, []);

  const value = useMemo<NotificationsApi>(
    () => ({ notifications, unreadCount, failed, refresh, markRead, markAllRead }),
    [notifications, unreadCount, failed, refresh, markRead, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
