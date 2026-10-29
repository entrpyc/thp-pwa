import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { PushMessage } from '@thp/shared';
import type { FcmSettings } from './env';
import { PUSH_TTL_SECONDS, type PlatformSender, type PushSendResult, type PushTarget } from './transport';

/**
 * **FCM, through the HTTP v1 API** — the Android store build's route. No Firebase Admin SDK: the
 * API is one POST per device behind an OAuth2 bearer token, and the token is a signed JWT
 * exchanged at Google's token endpoint, which `crypto` and `fetch` cover. The Admin SDK would be
 * tens of megabytes for that exchange.
 *
 * **The access token is cached until a minute before it expires** (Google issues an hour). Minting
 * one per send would be a second request per push and a rate limit waiting to happen.
 *
 * Google's answers that mean *gone*: `404` with `UNREGISTERED` — the app was uninstalled or the
 * token was rotated — and `400` naming the registration token as invalid. Everything else is a
 * failure this send does not retry.
 *
 * The message carries `notification` (what Android shows when the app is in the background) and
 * `data` (what the Capacitor plugin hands the page on a press, and what it shows itself in the
 * foreground). `href` is the whole of the press: the page navigates to it.
 */

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Ten seconds for either request. A send is awaited inside the request that caused it — an
 * admin's publish, a member's reply — and a provider that hangs would otherwise hold that request
 * open for as long as the socket lasts (docs/security-audit-2026-10-29.md, finding 21). APNs
 * already has one; this is the same ceiling.
 */
export const FCM_TIMEOUT_MS = 10_000;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** RS256 over `header.claims`: the service-account assertion Google exchanges for a bearer token. */
function mintAssertion(settings: FcmSettings, key: KeyObject): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: settings.clientEmail,
      scope: SCOPE,
      aud: settings.tokenUri,
      iat: now,
      exp: now + 3_600,
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${base64url(signature)}`;
}

export function fcmSender(settings: FcmSettings, fetchImpl: typeof fetch = fetch): PlatformSender {
  const key = createPrivateKey(settings.privateKey);
  const endpoint = `https://fcm.googleapis.com/v1/projects/${settings.projectId}/messages:send`;

  let access: { token: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access !== null && Date.now() < access.expiresAt - 60_000) return access.token;
    const response = await fetchImpl(settings.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: mintAssertion(settings, key),
      }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`fcm token exchange ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('fcm token exchange answered no token');
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3_600;
    access = { token: body.access_token, expiresAt: Date.now() + lifetime * 1_000 };
    return access.token;
  }

  return {
    async send(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
      let token: string;
      try {
        token = await accessToken();
      } catch (cause) {
        return { outcome: 'failed', detail: describe(cause) };
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: target.endpoint,
              notification: { title: message.title, body: message.body },
              data: {
                notificationId: message.notificationId,
                kind: message.kind,
                href: message.href ?? '',
              },
              android: {
                priority: 'high',
                ttl: `${PUSH_TTL_SECONDS}s`,
                collapse_key: message.notificationId,
              },
            },
          }),
        });
      } catch (cause) {
        return { outcome: 'failed', detail: `fcm request: ${describe(cause)}` };
      }

      if (response.ok) return { outcome: 'sent' };
      const text = await response.text().catch(() => '');
      // A revoked bearer token is answered 401; the next send mints a fresh one.
      if (response.status === 401) access = null;
      if (
        response.status === 404 ||
        (response.status === 400 && /registration token|INVALID_ARGUMENT/.test(text) && /token/i.test(text))
      ) {
        return { outcome: 'gone', detail: `fcm ${response.status}` };
      }
      return { outcome: 'failed', detail: `fcm ${response.status}: ${text.slice(0, 200)}` };
    },
  };
}

function describe(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
}
