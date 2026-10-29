import type { PushPlatform } from '@thp/shared';

/**
 * **What a store push token may look like** (security audit, finding 12). The web endpoint's
 * rule — one of the known push services, nothing else — lives beside the sender in `@thp/push`
 * (`isAllowedWebPushEndpoint`), because that package is the only one allowed to name a push
 * provider. A store token is the opaque string APNs or FCM issued: not a URL, and with a character
 * set, which is checked so a token can never carry a path separator or a header into the request
 * the sender builds from it.
 */

/** APNs issues hex; FCM issues a base64url-ish string with colons. Both bounded by the column. */
const STORE_TOKEN_SHAPE: Record<Exclude<PushPlatform, 'web'>, RegExp> = {
  ios: /^[0-9a-fA-F]{1,512}$/,
  android: /^[A-Za-z0-9_:.-]{1,512}$/,
};

/** Whether `token` is in the character set the platform's push service issues. */
export function isStoreToken(platform: Exclude<PushPlatform, 'web'>, token: string): boolean {
  return STORE_TOKEN_SHAPE[platform].test(token);
}
