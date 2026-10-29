import webpush from 'web-push';
import type { PushMessage } from '@thp/shared';
import type { VapidSettings } from './env';
import { PUSH_TTL_SECONDS, type PlatformSender, type PushSendResult, type PushTarget } from './transport';

/**
 * **Web Push, through the `web-push` library** — the one file in the repository that imports it
 * (tools/push-boundary.ts pins the name). The library does the two things worth not rewriting:
 * the VAPID JWT the push service authenticates us by, and the `aes128gcm` encryption to the
 * subscription's keys, which is what makes the message unreadable to the push service in between.
 *
 * A browser or installed PWA on any platform, iOS 16.4+ included — provided the member added the
 * app to the home screen, which is the one thing a page cannot do for them (project prd 7.2.2).
 *
 * `404` and `410` are the service saying the subscription no longer exists — the member revoked
 * permission or cleared site data — and are the only two answers that mean *gone*. Everything
 * else is a failure this send does not retry.
 */
export const WEB_PUSH_TIMEOUT_MS = 10_000;

export function webPushSender(settings: VapidSettings): PlatformSender {
  return {
    async send(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
      if (target.p256dh === null || target.auth === null) {
        return { outcome: 'failed', detail: 'web subscription without keys' };
      }
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(message),
          {
            TTL: PUSH_TTL_SECONDS,
            urgency: 'normal',
            // The same ceiling FCM and APNs have: a push service that hangs must not hold the
            // member's request open (docs/security-audit-2026-10-29.md, finding 21).
            timeout: WEB_PUSH_TIMEOUT_MS,
            vapidDetails: {
              subject: settings.subject,
              publicKey: settings.publicKey,
              privateKey: settings.privateKey,
            },
          },
        );
        return { outcome: 'sent' };
      } catch (cause) {
        const status = (cause as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) return { outcome: 'gone', detail: `web push ${status}` };
        return {
          outcome: 'failed',
          detail: `web push ${typeof status === 'number' ? status : 'error'}: ${describe(cause)}`,
        };
      }
    },
  };
}

function describe(cause: unknown): string {
  // The library's error message quotes the endpoint, which is a capability URL; the status and
  // the first line are what an operator needs.
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split('\n')[0]?.slice(0, 200) ?? '';
}

/**
 * **The hosts a browser's push endpoint may be on** (docs/security-audit-2026-10-28.md, finding
 * 12). A web endpoint is a URL this process will later POST to with the VAPID bearer token, from
 * the production box, sixteen at a time; a registration naming any `https://` URL made the
 * dispatcher a request whose destination the member chooses. Browsers are issued endpoints by a
 * handful of services, and those are the only hosts accepted. A browser that appears with a new
 * one fails registration with a clear message, and the host is added here on purpose rather than
 * discovered in a log. Here, beside the sender, because this is the one file allowed to know a
 * push provider's name (tools/push-boundary.ts).
 *
 * Suffixes, matched on the whole host or at a dot boundary.
 */
export const WEB_PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Brave, Opera, Vivaldi, Samsung Internet
  'android.googleapis.com', // Older Chrome registrations
  'push.apple.com', // Safari and installed PWAs on iOS and macOS: web.push.apple.com
  'push.services.mozilla.com', // Firefox: updates.push.services.mozilla.com
  'notify.windows.com', // Edge on Windows: wns2-*.notify.windows.com
  'push.samsungosp.com', // Samsung Internet's own service
];

/** Whether `address` is an `https://` URL, without credentials, on one of the known push services. */
export function isAllowedWebPushEndpoint(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return WEB_PUSH_SERVICE_HOSTS.some((service) => host === service || host.endsWith(`.${service}`));
}
