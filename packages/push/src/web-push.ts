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
