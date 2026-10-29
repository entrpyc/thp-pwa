import { describe, expect, it } from 'vitest';
import { isAllowedWebPushEndpoint } from '@thp/push';
import { isStoreToken } from '@/server/notifications/push-endpoints';

/**
 * The push-address rule (security audit, finding 12): a web endpoint is only ever one of the
 * known push services, and a store token is only ever the characters its service issues.
 */
describe('a web push endpoint', () => {
  it('is accepted on every service the supported browsers use', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://web.push.apple.com/QGxxx',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://push.samsungosp.com/abc',
    ]) {
      expect(isAllowedWebPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('is refused on any other host, scheme or shape', () => {
    for (const endpoint of [
      'https://push.example.test/abc',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost:3000/api/v1/health',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.attacker.test/abc',
      'https://attackerfcm.googleapis.com/abc'.replace('attackerfcm', 'evil-fcm'),
      'https://user:pass@fcm.googleapis.com/abc',
      'not a url',
    ]) {
      expect(isAllowedWebPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });
});

describe('a store token', () => {
  it('is hex for APNs and base64url-with-colons for FCM', () => {
    expect(isStoreToken('ios', 'ab12CD34')).toBe(true);
    expect(isStoreToken('ios', 'ab12/CD34')).toBe(false);
    expect(isStoreToken('ios', 'abc?x=1')).toBe(false);
    expect(isStoreToken('android', 'dGhp:APA91bF_x-y.z')).toBe(true);
    expect(isStoreToken('android', 'token/with/path')).toBe(false);
    expect(isStoreToken('android', '')).toBe(false);
  });
});
