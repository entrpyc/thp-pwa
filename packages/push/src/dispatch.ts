import {
  deletePushSubscriptionsById,
  listPushDeliveries,
  type Executor,
  type PushDeliveryRow,
} from '@thp/db';
import type { PushMessage, PushPlatform } from '@thp/shared';
import { logger } from '@thp/shared/observability/logger';
import { captureTransport, offTransport } from './capture';
import {
  readApnsSettings,
  readFcmSettings,
  readPushTransportName,
  readVapidSettings,
  type EnvSource,
} from './env';
import { apnsSender } from './apns';
import { fcmSender } from './fcm';
import type { PlatformSender, PushOutcome, PushSendResult, PushTarget, PushTransport } from './transport';
import { webPushSender } from './web-push';

/**
 * **The second delivery** ([3.17.1](docs/project/prd.md); project tdd 6.5). Hand it the ids of
 * notification rows just written, and every device of every recipient whose switch allows it is
 * sent the row's own words.
 *
 * **Throws nothing, ever.** The rows are already in the centre; a push that could not be sent is
 * a line in the log and a row that stays unread until the member opens the app, which is the
 * same thing that happens to a member with no device registered. The caller — the API's
 * `raise`, the worker's draft handler — has already decided the event counts; this must never
 * make it un-count. That includes configuration: a deployment with no keys at all runs, says
 * `push.unconfigured` once per channel per process, and sends nothing.
 *
 * **Dead addresses are removed as they are discovered.** A `gone` answer deletes the
 * subscription, so the table is only ever addresses recently known to work and the next event
 * does not pay for the same dead device again.
 *
 * Sends run with bounded concurrency rather than all at once: an announcement to a thousand
 * members with two devices each is two thousand HTTPS requests, and firing them in one `Promise.all`
 * is how a push service answers 429 for the rest of the day.
 */

export interface DispatchOptions {
  readonly transport?: PushTransport;
  readonly executor?: Executor;
}

export interface DispatchReport {
  readonly deliveries: number;
  readonly sent: number;
  readonly gone: number;
  readonly failed: number;
  readonly unconfigured: number;
}

const CONCURRENCY = 16;

export async function deliverPush(
  notificationIds: readonly string[],
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const report = { deliveries: 0, sent: 0, gone: 0, failed: 0, unconfigured: 0 };
  if (notificationIds.length === 0) return report;

  let deliveries: PushDeliveryRow[];
  let transport: PushTransport;
  try {
    [deliveries, transport] = await Promise.all([
      listPushDeliveries(notificationIds, options.executor),
      Promise.resolve(options.transport ?? configuredTransport()),
    ]);
  } catch (caught) {
    logger.error('push.failed', { stage: 'prepare', reason: describe(caught) });
    return report;
  }
  report.deliveries = deliveries.length;
  if (deliveries.length === 0) return report;

  const gone: string[] = [];
  const queue = [...deliveries];
  async function drain(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const result = await sendOne(transport, next);
      report[result.outcome] += 1;
      if (result.outcome === 'gone') gone.push(next.subscriptionId);
      if (result.outcome === 'failed') {
        logger.warn('push.send.failed', {
          notificationId: next.notificationId,
          subscriptionId: next.subscriptionId,
          platform: next.platform,
          reason: result.detail ?? '',
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, drain));

  if (gone.length > 0) {
    try {
      const removed = await deletePushSubscriptionsById(gone, options.executor);
      logger.info('push.subscriptions.removed', { removed, reason: 'provider-reported-gone' });
    } catch (caught) {
      logger.error('push.failed', { stage: 'remove-gone', reason: describe(caught) });
    }
  }

  logger.info('push.delivered', { transport: transport.name, notifications: notificationIds.length, ...report });
  return report;
}

async function sendOne(transport: PushTransport, delivery: PushDeliveryRow): Promise<PushSendResult> {
  const target: PushTarget = {
    subscriptionId: delivery.subscriptionId,
    platform: delivery.platform,
    endpoint: delivery.endpoint,
    p256dh: delivery.p256dh,
    auth: delivery.auth,
  };
  const message: PushMessage = {
    notificationId: delivery.notificationId,
    kind: delivery.kind,
    title: delivery.title,
    body: delivery.body,
    href: delivery.href,
  };
  try {
    return await transport.send(target, message);
  } catch (caught) {
    // A transport promises not to throw; this is the promise being kept on its behalf.
    return { outcome: 'failed', detail: describe(caught) };
  }
}

// =================================================================================================
// The configured transport
// =================================================================================================

let cached: PushTransport | undefined;

/**
 * The transport this process is configured with, built once. Lazy, so a process that never
 * delivers a push — a worker running only previews — never reads a key it does not need, and so
 * a misconfiguration surfaces at the first delivery as a logged `push.failed` rather than at boot.
 */
export function configuredTransport(env: EnvSource = process.env): PushTransport {
  cached ??= buildTransport(env);
  return cached;
}

/** Exported for the unit test; nothing else builds one by hand. */
export function buildTransport(env: EnvSource = process.env): PushTransport {
  switch (readPushTransportName(env)) {
    case 'capture':
      return captureTransport(env);
    case 'off':
      return offTransport();
    case 'real':
      return realTransport(env);
  }
}

/**
 * The three channels behind one `send`, each built on first use and each allowed to be absent.
 * An absent channel answers `unconfigured` for every device on it and is logged once.
 */
export function realTransport(env: EnvSource = process.env): PushTransport {
  const senders = new Map<PushPlatform, PlatformSender | null>();
  const warned = new Set<PushPlatform>();

  function senderFor(platform: PushPlatform): PlatformSender | null {
    if (!senders.has(platform)) {
      senders.set(platform, buildSender(platform, env));
    }
    return senders.get(platform) ?? null;
  }

  return {
    name: 'real',
    async send(target, message) {
      let sender: PlatformSender | null;
      try {
        sender = senderFor(target.platform);
      } catch (caught) {
        // A key set wrongly: said once per channel, and the channel stays off for the process.
        senders.set(target.platform, null);
        if (!warned.has(target.platform)) {
          warned.add(target.platform);
          logger.error('push.misconfigured', { platform: target.platform, reason: describe(caught) });
        }
        return { outcome: 'unconfigured', detail: describe(caught) };
      }
      if (sender === null) {
        if (!warned.has(target.platform)) {
          warned.add(target.platform);
          logger.warn('push.unconfigured', {
            platform: target.platform,
            reason: `no credentials for ${target.platform} push in this deployment — see .env.example`,
          });
        }
        return { outcome: 'unconfigured' };
      }
      return sender.send(target, message);
    },
  };
}

function buildSender(platform: PushPlatform, env: EnvSource): PlatformSender | null {
  switch (platform) {
    case 'web': {
      const vapid = readVapidSettings(env);
      return vapid === null ? null : webPushSender(vapid);
    }
    case 'ios': {
      const apns = readApnsSettings(env);
      return apns === null ? null : apnsSender(apns);
    }
    case 'android': {
      const fcm = readFcmSettings(env);
      return fcm === null ? null : fcmSender(fcm);
    }
  }
}

/** The outcomes, for a caller that wants to count them without knowing the union. */
export const PUSH_OUTCOMES: readonly PushOutcome[] = ['sent', 'gone', 'failed', 'unconfigured'];

function describe(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
}
