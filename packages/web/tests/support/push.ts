import { readFileSync, statSync } from 'node:fs';
import type { PushMessage } from '@thp/shared';

/**
 * Reading what the primary server would have pushed.
 *
 * The suite runs that server with `PUSH_TRANSPORT=capture`, which appends one JSON line per
 * device per notification instead of reaching a push service. Assertions read that file — so
 * "the author's two devices were sent the reply, and the member who switched notes off was not"
 * is checked against what the dispatcher actually handed the transport, with the preference rule
 * applied by the real query.
 */

export interface CapturedPush {
  readonly subscriptionId: string;
  readonly platform: 'web' | 'ios' | 'android';
  readonly endpoint: string;
  readonly message: PushMessage;
  readonly capturedAt: string;
}

/** Byte offset to read the next slice of the file from, mirroring the mail reader. */
export function pushOffset(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isCapturedPush(value: unknown): value is CapturedPush {
  const candidate = value as CapturedPush;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.endpoint === 'string' &&
    typeof candidate.message === 'object' &&
    candidate.message !== null &&
    typeof candidate.message.title === 'string'
  );
}

export function readCapturedPush(path: string, offset = 0): CapturedPush[] {
  let raw: string;
  try {
    raw = readFileSync(path).subarray(offset).toString('utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(isCapturedPush);
}

/**
 * Wait for the capture to hold at least `count` lines past `offset` for the given endpoint. The
 * dispatcher runs after the route has answered — the push is a second delivery — so a read the
 * instant the response lands can be a line early.
 */
export async function waitForCapturedPush(
  path: string,
  offset: number,
  endpoint: string,
  count: number,
  timeoutMs = 10_000,
): Promise<CapturedPush[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = readCapturedPush(path, offset).filter((one) => one.endpoint === endpoint);
    if (lines.length >= count || Date.now() > deadline) return lines;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
