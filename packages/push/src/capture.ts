import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PushMessage } from '@thp/shared';
import { readPushCapturePath, type EnvSource } from './env';
import type { PushSendResult, PushTarget, PushTransport } from './transport';

/**
 * **The fake: every would-be push, appended to a file.** Development and test. One JSON line per
 * device per notification — the target and the message as the real transport would have been
 * handed them — so a test asserts against what was *dispatched* rather than against a mock of the
 * dispatcher, and a developer can tail the file while pressing things.
 *
 * Synchronous and append-only, as the mail capture is: two deliveries at once must not interleave
 * halves of two lines.
 *
 * **One behaviour the real services have that the suite needs to drive**: an address that is
 * gone. An endpoint ending in {@link GONE_MARKER} is answered `gone`, so "a dead subscription is
 * removed" is a thing the integration suite can prove without a push service in the loop. Real
 * endpoints are URLs and tokens; neither ends in a fragment, and the marker is never written by
 * anything but a test.
 */

export const GONE_MARKER = '#gone';

/** What one captured line holds. */
export interface CapturedPush {
  readonly subscriptionId: string;
  readonly platform: PushTarget['platform'];
  readonly endpoint: string;
  readonly message: PushMessage;
  readonly capturedAt: string;
}

export function captureTransport(env: EnvSource = process.env): PushTransport {
  const path = readPushCapturePath(env);
  return {
    name: 'capture',
    async send(target: PushTarget, message: PushMessage): Promise<PushSendResult> {
      if (target.endpoint.endsWith(GONE_MARKER)) return { outcome: 'gone', detail: 'capture: marked gone' };
      const line: CapturedPush = {
        subscriptionId: target.subscriptionId,
        platform: target.platform,
        endpoint: target.endpoint,
        message,
        capturedAt: new Date().toISOString(),
      };
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
      return { outcome: 'sent' };
    },
  };
}

/** Sends nothing, says nothing: `PUSH_TRANSPORT=off`. */
export function offTransport(): PushTransport {
  return {
    name: 'off',
    async send(): Promise<PushSendResult> {
      return { outcome: 'unconfigured', detail: 'push transport is off' };
    },
  };
}
