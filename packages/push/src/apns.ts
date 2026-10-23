import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import type { PushMessage } from '@thp/shared';
import type { ApnsSettings } from './env';
import { PUSH_TTL_SECONDS, type PlatformSender, type PushSendResult, type PushTarget } from './transport';

/**
 * **APNs, spoken directly** — HTTP/2 to Apple with a token-based (`.p8`) key, which is the route
 * the operator chose over relaying through Firebase. No library: the protocol is one POST per
 * device with a JWT in the header, and Node's `http2` and `crypto` cover both. A dependency here
 * would be a second copy of forty lines.
 *
 * **The provider token is minted once and reused for fifty minutes.** Apple refuses a token older
 * than an hour and throttles a connection that mints a fresh one per request, so the cached token
 * is the correct shape, not an optimisation. One session is kept open for the same reason — APNs
 * expects long-lived connections — and reopened when it closes or errors.
 *
 * Apple's answers that mean *gone*: `410`, or `400` with reason `BadDeviceToken` /
 * `Unregistered` / `DeviceTokenNotForTopic`. The first two say the token is dead; the third says
 * it was registered under another bundle id and will never match this one. Everything else is a
 * failure this send does not retry.
 */

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

const TOKEN_LIFETIME_MS = 50 * 60 * 1_000;

const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** ES256 over `header.claims`, as RFC 7519 lays it out and Apple reads it. */
function mintProviderToken(settings: ApnsSettings, key: KeyObject): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: settings.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: settings.teamId, iat: Math.floor(Date.now() / 1_000) }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

export function apnsSender(settings: ApnsSettings): PlatformSender {
  const key = createPrivateKey(settings.privateKey);
  const host = settings.environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST;

  let token: { value: string; mintedAt: number } | null = null;
  let session: ClientHttp2Session | null = null;

  function providerToken(): string {
    if (token === null || Date.now() - token.mintedAt > TOKEN_LIFETIME_MS) {
      token = { value: mintProviderToken(settings, key), mintedAt: Date.now() };
    }
    return token.value;
  }

  function openSession(): ClientHttp2Session {
    if (session !== null && !session.closed && !session.destroyed) return session;
    const fresh = connect(host);
    fresh.on('error', () => {
      // The next send reopens. Without a listener an error here would be an uncaught exception
      // that takes the process down over one push.
      if (session === fresh) session = null;
    });
    fresh.on('close', () => {
      if (session === fresh) session = null;
    });
    session = fresh;
    return fresh;
  }

  return {
    send(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
      const body = JSON.stringify({
        aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
        notificationId: message.notificationId,
        kind: message.kind,
        href: message.href,
      });

      return new Promise((resolve) => {
        let request;
        try {
          request = openSession().request({
            [constants.HTTP2_HEADER_METHOD]: 'POST',
            [constants.HTTP2_HEADER_PATH]: `/3/device/${target.endpoint}`,
            authorization: `bearer ${providerToken()}`,
            'apns-topic': settings.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'apns-expiration': String(Math.floor(Date.now() / 1_000) + PUSH_TTL_SECONDS),
            'apns-collapse-id': message.notificationId,
            'content-type': 'application/json',
          });
        } catch (cause) {
          resolve({ outcome: 'failed', detail: `apns connect: ${describe(cause)}` });
          return;
        }

        let status = 0;
        const chunks: Buffer[] = [];
        request.on('response', (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          if (status === 200) {
            resolve({ outcome: 'sent' });
            return;
          }
          let reason = '';
          try {
            reason = String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown }).reason ?? '');
          } catch {
            // No body, or not JSON: the status is the whole answer.
          }
          if (status === 410 || (status === 400 && GONE_REASONS.has(reason))) {
            resolve({ outcome: 'gone', detail: `apns ${status} ${reason}`.trim() });
            return;
          }
          if (status === 403 && reason === 'ExpiredProviderToken') token = null;
          resolve({ outcome: 'failed', detail: `apns ${status} ${reason}`.trim() });
        });
        request.on('error', (cause) => {
          resolve({ outcome: 'failed', detail: `apns request: ${describe(cause)}` });
        });
        request.setTimeout(15_000, () => {
          request.close(constants.NGHTTP2_CANCEL);
          resolve({ outcome: 'failed', detail: 'apns timeout' });
        });
        request.end(body);
      });
    },
  };
}

function describe(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
}
