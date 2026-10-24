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
  NOTIFICATIONS_BEFORE_PARAM,
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
 *
 * **Pages.** A read answers the newest page only, and the centre asks for the next one with
 * {@link NotificationsApi.loadMore} as the member scrolls. A re-read replaces the first page and
 * **keeps the older pages the member has already scrolled to**: the minute poll must not throw a
 * member who is forty rows down back to the top ten. Rows the fresh page covers are taken from it,
 * rows older than its last are kept as held, and the cursor stays wherever the member had got to.
 */

const POLL_MS = 60_000;

export interface NotificationsApi {
  /** The rows the centre lists, newest first, or `null` before the first read lands. */
  readonly notifications: readonly NotificationView[] | null;
  /** What the bell prints. Zero before the first read, so the bell never shows a stale number. */
  readonly unreadCount: number;
  /** Whether the last read failed. The bell stays quiet; the centre says so. */
  readonly failed: boolean;
  /** Whether there are older rows than the ones held. `false` until the first read lands. */
  readonly hasMore: boolean;
  /** Whether a {@link loadMore} is in flight. The centre says so at the foot of the list. */
  readonly loadingMore: boolean;
  /** Whether the last {@link loadMore} failed. The centre offers to try again. */
  readonly moreFailed: boolean;
  refresh(): Promise<void>;
  /** Read the next page of older rows and append it. A no-op while one is in flight or at the end. */
  loadMore(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

const NotificationsContext = createContext<NotificationsApi | null>(null);

export function useNotifications(): NotificationsApi {
  const value = useContext(NotificationsContext);
  if (value === null) throw new Error('useNotifications used outside the member layout');
  return value;
}

/** The rows held and where the next page starts — one value, so the two can never disagree. */
interface Held {
  readonly rows: readonly NotificationView[];
  readonly nextCursor: string | null;
}

/** The list's order, newest first: `true` when `a` would be listed after `b`. */
function isOlder(a: NotificationView, b: NotificationView): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

/**
 * A fresh first page laid over what is held. The page's rows win where they overlap; held rows
 * older than the page's last stay, so a member who has scrolled down is not pulled back up. When the
 * page says there is nothing older — `nextCursor` null — the held tail is gone from the server and
 * is dropped here too.
 */
function overlay(held: Held | null, page: NotificationListPayload): Held {
  const fresh = page.notifications;
  const last = fresh[fresh.length - 1];
  if (held === null || last === undefined || page.nextCursor === null) {
    return { rows: fresh, nextCursor: page.nextCursor };
  }
  const seen = new Set(fresh.map((one) => one.id));
  const tail = held.rows.filter((one) => !seen.has(one.id) && isOlder(one, last));
  return tail.length === 0
    ? { rows: fresh, nextCursor: page.nextCursor }
    : { rows: [...fresh, ...tail], nextCursor: held.nextCursor };
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [held, setHeld] = useState<Held | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  // A read that lands after a later one started must not overwrite it. Each read takes a ticket
  // and only the latest ticket is allowed to write.
  const ticket = useRef(0);
  // One next page at a time: a sentinel that stays in view while a page is loading must not ask
  // for the same page twice. A ref rather than state, so the guard holds within the same render.
  const loadingMoreRef = useRef(false);
  // What the next page starts from, readable from a callback without re-creating it per page.
  const cursorRef = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++ticket.current;
    try {
      const payload = await apiFetch<NotificationListPayload>(NOTIFICATIONS_PATH, {
        credentials: 'include',
      });
      if (mine !== ticket.current) return;
      setHeld((current) => {
        const next = overlay(current, payload);
        cursorRef.current = next.nextCursor;
        return next;
      });
      setUnreadCount(payload.unreadCount);
      setFailed(false);
    } catch {
      if (mine !== ticket.current) return;
      setFailed(true);
    }
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = cursorRef.current;
    if (cursor === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const query = new URLSearchParams({ [NOTIFICATIONS_BEFORE_PARAM]: cursor });
      const payload = await apiFetch<NotificationListPayload>(`${NOTIFICATIONS_PATH}?${query}`, {
        credentials: 'include',
      });
      setHeld((current) => {
        const rows = current?.rows ?? [];
        const seen = new Set(rows.map((one) => one.id));
        const next = {
          rows: [...rows, ...payload.notifications.filter((one) => !seen.has(one.id))],
          nextCursor: payload.nextCursor,
        };
        cursorRef.current = next.nextCursor;
        return next;
      });
      setUnreadCount(payload.unreadCount);
    } catch {
      setMoreFailed(true);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
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
    // computed over every row rather than over the pages this client happens to hold.
    setHeld((current) =>
      current === null
        ? current
        : { ...current, rows: current.rows.map((one) => (one.id === id ? payload.notification : one)) },
    );
    setUnreadCount(payload.unreadCount);
  }, []);

  const markAllRead = useCallback(async (): Promise<void> => {
    const payload = await apiFetch<NotificationsReadAllPayload>(NOTIFICATIONS_READ_ALL_PATH, {
      method: 'PUT',
      credentials: 'include',
    });
    const now = new Date().toISOString();
    setHeld((current) =>
      current === null
        ? current
        : {
            ...current,
            rows: current.rows.map((one) => (one.readAt === null ? { ...one, readAt: now } : one)),
          },
    );
    setUnreadCount(payload.unreadCount);
  }, []);

  const value = useMemo<NotificationsApi>(
    () => ({
      notifications: held?.rows ?? null,
      unreadCount,
      failed,
      hasMore: (held?.nextCursor ?? null) !== null,
      loadingMore,
      moreFailed,
      refresh,
      loadMore,
      markRead,
      markAllRead,
    }),
    [held, unreadCount, failed, loadingMore, moreFailed, refresh, loadMore, markRead, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
