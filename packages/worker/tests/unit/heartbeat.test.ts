import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '@thp/shared/observability/logger';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_SENT_MESSAGE,
  HEARTBEAT_URL_VARIABLE,
  createHeartbeat,
  isHeartbeatDue,
  readHeartbeatUrl,
} from '../../src/observability/heartbeat';

/**
 * **The worker's dead-man's switch** (docs/project/observability.md § 2.4) — asserted without a
 * network and without a clock: when it is due, what it does when it cannot get out, and that a
 * deployment with no check configured is a deployment that says so once and pings nothing.
 */

const URL = 'https://hc-ping.com/00000000-0000-0000-0000-000000000000';

let lines: { message: string; [key: string]: unknown }[] = [];
let restoreSink: () => void;

beforeAll(() => {
  restoreSink = setLogSink((line) => {
    lines.push(line as { message: string });
  });
});
afterAll(() => restoreSink());

async function settled(): Promise<void> {
  // Let the fire-and-forget promise chain run to its `finally`.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('when a beat is due', () => {
  it('is due at once, then every five minutes', () => {
    expect(isHeartbeatDue(null, 1_000)).toBe(true);
    expect(isHeartbeatDue(1_000, 1_000 + HEARTBEAT_INTERVAL_MS - 1)).toBe(false);
    expect(isHeartbeatDue(1_000, 1_000 + HEARTBEAT_INTERVAL_MS)).toBe(true);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5 * 60_000);
  });
});

describe('the URL', () => {
  it('is read trimmed, and absent means none', () => {
    expect(readHeartbeatUrl({ [HEARTBEAT_URL_VARIABLE]: ` ${URL} ` })).toBe(URL);
    expect(readHeartbeatUrl({ [HEARTBEAT_URL_VARIABLE]: '   ' })).toBeNull();
    expect(readHeartbeatUrl({})).toBeNull();
  });
});

describe('beating from inside the loop', () => {
  it('sends on the first beat, not again until the interval has passed, and logs each send', async () => {
    lines = [];
    let now = 1_000_000;
    const send = vi.fn(async () => undefined);
    const heartbeat = createHeartbeat({ env: { [HEARTBEAT_URL_VARIABLE]: URL }, send, now: () => now });

    heartbeat.beat();
    heartbeat.beat();
    await settled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(URL);

    now += HEARTBEAT_INTERVAL_MS - 1;
    heartbeat.beat();
    expect(send).toHaveBeenCalledTimes(1);

    now += 1;
    heartbeat.beat();
    await settled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(lines.filter((line) => line.message === HEARTBEAT_SENT_MESSAGE)).toHaveLength(2);
  });

  it('logs a ping that could not get out and carries on, costing the loop nothing', async () => {
    lines = [];
    const send = vi.fn(async () => {
      throw new Error('the check answered 503');
    });
    const heartbeat = createHeartbeat({ env: { [HEARTBEAT_URL_VARIABLE]: URL }, send, now: () => 5 });

    expect(() => heartbeat.beat()).not.toThrow();
    await settled();
    expect(lines.map((line) => line.message)).toEqual(['worker.heartbeat.failed']);
    expect(lines[0]?.['error']).toBe('the check answered 503');
  });

  it('says once at boot that there is no URL, and then does nothing at all', async () => {
    lines = [];
    const send = vi.fn(async () => undefined);
    const heartbeat = createHeartbeat({ env: {}, send });

    heartbeat.beat();
    heartbeat.beat();
    await settled();
    expect(send).not.toHaveBeenCalled();
    expect(lines.map((line) => line.message)).toEqual(['worker.heartbeat.off']);
  });
});
