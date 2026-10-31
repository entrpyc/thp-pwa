/*
 * Push notifications (PRD 3.17.1). Loaded by `/sw.js`; see its header for how modules compose.
 *
 * Two handlers, and they are the whole of what a browser needs from the worker for push:
 *
 * - `push` turns the server's message into a system notification. The payload is the
 *   notification row's own words — title, body, the path a press lands on — written by the API
 *   (`@thp/push`) and encrypted to this subscription's keys, so what is shown is what the centre
 *   lists. A payload that is not JSON, or is missing a title, is shown as a generic line rather
 *   than dropped: the push service counted it as delivered, and a browser that is handed a push
 *   and shows nothing may revoke the subscription. `tag` is the row's id, so a second push for
 *   the same row (a reaction replacing an earlier one) replaces rather than stacks.
 *
 * - `notificationclick` lands the press where the row points (PRD 3.17.3): an open tab of the app
 *   is focused and navigated, otherwise a new window is opened. A row with no destination — an
 *   admin announcement — lands on the centre, which is where the message lives. Paths only: the
 *   payload carries a path on this origin, and anything else is replaced by the centre, so a
 *   malformed payload can never open another site.
 *
 * Marking the row read is the page's business, not the worker's: the page the press opens reads
 * the centre, and the member sees the row there with the dot still on it until they press it,
 * which is the same state a press on the bell would show. The worker holds no session and makes
 * no API call.
 */

const NOTIFICATIONS_PAGE = '/notifications';
const ICON = '/icons/icon-192.png';

/**
 * A path on this origin, or the centre. Never a URL. Decided by resolving the value against this
 * origin and comparing origins, not by looking at the first characters: `/\evil.example` begins
 * with one slash and resolves off-origin (docs/security-audit-2026-10-29.md, finding 22).
 */
function landingPath(href) {
  if (typeof href !== 'string' || !href.startsWith('/')) return NOTIFICATIONS_PAGE;
  try {
    const resolved = new URL(href, self.location.origin);
    if (resolved.origin !== self.location.origin) return NOTIFICATIONS_PAGE;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch (_) {
    return NOTIFICATIONS_PAGE;
  }
}

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data === 'object' && typeof data.title === 'string') return data;
  } catch (_) {
    // Not JSON: shown generically below.
  }
  return null;
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  const title = payload ? payload.title : 'Vinegard';
  const options = {
    body: payload && typeof payload.body === 'string' ? payload.body : '',
    icon: ICON,
    badge: ICON,
    tag: payload && typeof payload.notificationId === 'string' ? payload.notificationId : undefined,
    data: { href: landingPath(payload ? payload.href : null), kind: payload ? payload.kind : null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = landingPath(event.notification.data ? event.notification.data.href : null);
  const target = new URL(href, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) {
        // Focus first, then navigate: a client that refuses navigation (an uncontrolled page,
        // say) still comes to the front, which is better than a press that does nothing.
        return open.focus().then((focused) => (focused && focused.navigate ? focused.navigate(target) : focused));
      }
      return self.clients.openWindow(target);
    }),
  );
});
