import {
  API_PREFIX,
  NOTIFICATIONS_BEFORE_PARAM,
  NOTIFICATIONS_PATH,
  type NotificationListPayload,
  type NotificationView,
} from '@thp/shared';

/**
 * **Everything in somebody's notification centre**, every page followed to the end.
 *
 * The route answers a page of {@link NOTIFICATIONS_PAGE_SIZE} and a cursor for the next, and the
 * integration suites share one database: a member made by one file is told about every teaching
 * every other file publishes, so a row this file wrote may be several pages down by the time it is
 * asserted on. A test that reads one page and filters is a test that passes alone and fails in the
 * run; this reads them all, so the filter sees the whole inbox.
 */
export async function readWholeInbox(
  baseUrl: string,
  cookie: string,
): Promise<{ notifications: NotificationView[]; unreadCount: number; pages: number }> {
  const notifications: NotificationView[] = [];
  let unreadCount = 0;
  let pages = 0;
  let before: string | null = null;
  do {
    const query = before === null ? '' : `?${new URLSearchParams({ [NOTIFICATIONS_BEFORE_PARAM]: before })}`;
    const response = await fetch(`${baseUrl}${API_PREFIX}${NOTIFICATIONS_PATH}${query}`, {
      headers: { accept: 'application/json', cookie },
    });
    if (response.status !== 200) throw new Error(`inbox refused ${response.status}`);
    const page = (await response.json()) as NotificationListPayload;
    notifications.push(...page.notifications);
    unreadCount = page.unreadCount;
    pages += 1;
    before = page.nextCursor;
  } while (before !== null);
  return { notifications, unreadCount, pages };
}
