import type { PushMessage, PushPlatform } from '@thp/shared';

/**
 * **The port every push goes through.** One `send` per device, answering what happened in a
 * vocabulary the dispatcher can act on rather than a provider's own status codes:
 *
 * - `sent` — the push service accepted it. Whether the device shows it is the device's business.
 * - `gone` — the service says this address will never work again: the browser unsubscribed, the
 *   app was uninstalled, the token was revoked. The dispatcher deletes the subscription.
 * - `failed` — anything else: a network error, a 5xx, a bad key. The subscription stays, the
 *   failure is logged, and the next event tries again. Nothing retries within a send.
 * - `unconfigured` — the channel this device needs has no credentials in this deployment. Logged
 *   once per process so a deployment that has not set up the store builds is not told about it on
 *   every event.
 *
 * Three real adapters sit behind one of these, picked by the subscription's platform; the capture
 * fake answers for all three. Nothing outside this package sees a provider.
 */

/** One device, as the dispatcher hands it in. */
export interface PushTarget {
  readonly subscriptionId: string;
  readonly platform: PushPlatform;
  /** The Web Push endpoint URL, or the APNs / FCM device token. */
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
}

export type PushOutcome = 'sent' | 'gone' | 'failed' | 'unconfigured';

export interface PushSendResult {
  readonly outcome: PushOutcome;
  /** For the log: the provider's own reason, never anything a member typed. */
  readonly detail?: string;
}

export interface PushTransport {
  readonly name: string;
  send(target: PushTarget, message: PushMessage): Promise<PushSendResult>;
}

/** A transport for one platform; the real transport is three of these behind one `send`. */
export interface PlatformSender {
  send(target: PushTarget, message: PushMessage): Promise<PushSendResult>;
}

/** How long a push service should hold a message for a device that is offline: a day, as the centre's rows are read within one. */
export const PUSH_TTL_SECONDS = 86_400;
