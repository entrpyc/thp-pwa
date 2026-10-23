import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUSH_PLATFORMS, type PushMessage } from '@thp/shared';
import { GONE_MARKER, captureTransport } from '../../src/capture';
import { buildTransport, realTransport } from '../../src/dispatch';
import {
  readApnsSettings,
  readFcmSettings,
  readPushTransportName,
  readVapidSettings,
} from '../../src/env';
import type { PushTarget } from '../../src/transport';

/**
 * **The fake, and the configuration that picks it** — what every other test of push stands on.
 *
 * The capture transport is what the integration suite reads, so what it writes is asserted here
 * on its own: one line per send, the whole target and message, appended rather than replaced,
 * and the one behaviour the suite needs that a file cannot otherwise show — an address marked
 * gone is answered `gone` and written nowhere. The environment readers are asserted for the
 * property the dispatcher relies on: unset means `null`, set wrongly means a sentence naming the
 * variable, and a real transport with nothing configured sends nothing and refuses nothing.
 */

const MESSAGE: PushMessage = {
  notificationId: 'n-1',
  kind: 'note_reply',
  title: 'Ana replied to your note',
  body: 'A line of the reply',
  href: '/recordings/r-1',
};

function target(endpoint: string, platform: PushTarget['platform'] = 'web'): PushTarget {
  return { subscriptionId: `s-${endpoint}`, platform, endpoint, p256dh: platform === 'web' ? 'k' : null, auth: platform === 'web' ? 'a' : null };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thp-push-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the capture transport', () => {
  it('appends one JSON line per send with the target and the message, and answers sent', async () => {
    const path = join(dir, 'nested', 'push.jsonl');
    const transport = captureTransport({ PUSH_CAPTURE_PATH: path });
    expect(transport.name).toBe('capture');

    expect(await transport.send(target('https://push.test/a'), MESSAGE)).toEqual({ outcome: 'sent' });
    expect(await transport.send(target('token-b', 'android'), MESSAGE)).toEqual({ outcome: 'sent' });

    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ subscriptionId: 's-https://push.test/a', platform: 'web', endpoint: 'https://push.test/a', message: MESSAGE });
    expect(lines[1]).toMatchObject({ platform: 'android', endpoint: 'token-b' });
    expect(typeof lines[0]?.['capturedAt']).toBe('string');
  });

  it('answers gone for an address carrying the marker, and writes nothing for it', async () => {
    const path = join(dir, 'push.jsonl');
    const transport = captureTransport({ PUSH_CAPTURE_PATH: path });
    const result = await transport.send(target(`https://push.test/dead${GONE_MARKER}`), MESSAGE);
    expect(result.outcome).toBe('gone');
    expect(() => readFileSync(path)).toThrow();
  });

  it('refuses to be built without a path, naming the variable', () => {
    expect(() => captureTransport({})).toThrow(/PUSH_CAPTURE_PATH/);
  });
});

describe('which transport', () => {
  it('is real by default, capture under the mock switch whatever else says, and refuses an unknown name', () => {
    expect(readPushTransportName({})).toBe('real');
    expect(readPushTransportName({ PUSH_TRANSPORT: 'off' })).toBe('off');
    expect(readPushTransportName({ PUSH_TRANSPORT: 'real', THP_MOCK_EXTERNAL: 'true' })).toBe('capture');
    expect(() => readPushTransportName({ PUSH_TRANSPORT: 'smtp' })).toThrow(/PUSH_TRANSPORT/);
  });

  it('builds the fake and the off transport by name', async () => {
    expect(buildTransport({ PUSH_TRANSPORT: 'capture', PUSH_CAPTURE_PATH: join(dir, 'x.jsonl') }).name).toBe('capture');
    const off = buildTransport({ PUSH_TRANSPORT: 'off' });
    expect(off.name).toBe('off');
    expect((await off.send(target('https://push.test/a'), MESSAGE)).outcome).toBe('unconfigured');
  });

  it('a real transport with nothing configured answers unconfigured for every platform and throws nothing', async () => {
    const transport = realTransport({});
    for (const platform of PUSH_PLATFORMS) {
      expect((await transport.send(target('x', platform), MESSAGE)).outcome).toBe('unconfigured');
    }
  });

  it('a real transport with a key set wrongly answers unconfigured rather than throwing', async () => {
    const transport = realTransport({ VAPID_PUBLIC_KEY: 'only-half' });
    const result = await transport.send(target('https://push.test/a'), MESSAGE);
    expect(result.outcome).toBe('unconfigured');
    expect(result.detail).toMatch(/VAPID/);
  });
});

describe('the credential readers', () => {
  it('read nothing as null and half a VAPID pair as a mistake', () => {
    expect(readVapidSettings({})).toBeNull();
    expect(() => readVapidSettings({ VAPID_PUBLIC_KEY: 'p' })).toThrow(/together/);
    expect(() => readVapidSettings({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 's' })).toThrow(/VAPID_SUBJECT/);
    expect(readVapidSettings({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 's', VAPID_SUBJECT: 'mailto:ops@example.test' })).toEqual({ publicKey: 'p', privateKey: 's', subject: 'mailto:ops@example.test' });
  });

  it('read the APNs key only when its id is set, and insist on the rest', () => {
    expect(readApnsSettings({})).toBeNull();
    expect(() => readApnsSettings({ APNS_KEY_ID: 'K' })).toThrow(/APNS_TEAM_ID/);
    expect(() => readApnsSettings({ APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: 'nope' })).toThrow(/PEM/);
    const settings = readApnsSettings({
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
      APNS_ENVIRONMENT: 'sandbox',
    });
    expect(settings).toMatchObject({ keyId: 'K', teamId: 'T', environment: 'sandbox', bundleId: 'com.indepthwebsolutions.teachinghub' });
    // A key pasted with literal \n sequences, as a .env line has to be, is unfolded.
    expect(settings?.privateKey.split('\n')).toHaveLength(3);
  });

  it('read the Firebase service account as the JSON Firebase downloads', () => {
    expect(readFcmSettings({})).toBeNull();
    expect(() => readFcmSettings({ FCM_SERVICE_ACCOUNT: '{not json' })).toThrow(/JSON/);
    expect(() => readFcmSettings({ FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' })).toThrow(/client_email/);
    expect(readFcmSettings({ FCM_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p', client_email: 'c@p.iam', private_key: 'k' }) })).toEqual({
      projectId: 'p',
      clientEmail: 'c@p.iam',
      privateKey: 'k',
      tokenUri: 'https://oauth2.googleapis.com/token',
    });
  });
});
