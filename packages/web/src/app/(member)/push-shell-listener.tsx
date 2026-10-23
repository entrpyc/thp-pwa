'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PushNotifications } from '@capacitor/push-notifications';
import { NOTIFICATIONS_PAGE_PATH, isNotificationKind } from '@thp/shared';
import { track } from '@/client/observability/analytics';
import { shellPlatform } from '@/client/platform';
import { adoptShellToken } from '@/client/push/push-device';
import { useNotifications } from './notifications-context';

/**
 * **What the store shell does with a push** ([3.17.1](docs/project/prd.md),
 * [3.17.3](docs/project/prd.md), [5.2.5](docs/project/prd.md)) — the shell's half of what
 * `public/sw/push.js` does for a browser.
 *
 * In a store build the OS draws the notification and the Capacitor plugin reports the press to
 * the page, so landing it is the page's job: `pushNotificationActionPerformed` carries the
 * message's `data`, and `href` in it is the path the row points at. Paths only, exactly as the
 * worker insists — a payload that carries anything else lands on the centre.
 *
 * Two more events are listened for because they cost nothing and each closes a gap:
 *
 * - `pushNotificationReceived` fires when a push arrives while the app is **open**, and refreshes
 *   the bell, so a member looking at the app learns of a reply without waiting a minute for the
 *   poll.
 * - `registration` fires whenever the platform hands the app a token — on the press that asked
 *   for one, and on a rotation the platform decides on its own. A rotated token the server does
 *   not know is a device that quietly stops receiving, so it is adopted here; one that matches
 *   the remembered endpoint costs no request.
 *
 * Renders nothing, mounts nothing outside a shell, and asks for no permission: the prompt is the
 * settings section's button and only that.
 */
export function PushShellListener() {
  const router = useRouter();
  const { refresh } = useNotifications();

  useEffect(() => {
    if (shellPlatform() === null) return;
    const handles = [
      PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
        const data = (notification.data ?? {}) as Record<string, unknown>;
        const href = typeof data['href'] === 'string' && data['href'].startsWith('/') && !data['href'].startsWith('//')
          ? data['href']
          : NOTIFICATIONS_PAGE_PATH;
        if (isNotificationKind(data['kind'])) {
          track('notification_opened', { kind: data['kind'], channel: 'push' });
        }
        router.push(href);
      }),
      PushNotifications.addListener('pushNotificationReceived', () => {
        void refresh();
      }),
      PushNotifications.addListener('registration', (token) => {
        void adoptShellToken(token.value).catch(() => undefined);
      }),
    ];
    return () => {
      for (const handle of handles) void handle.then((one) => one.remove()).catch(() => undefined);
    };
  }, [router, refresh]);

  return null;
}
