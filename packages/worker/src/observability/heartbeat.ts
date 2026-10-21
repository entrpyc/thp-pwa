import { logger } from '@thp/shared/observability/logger';

/**
 * **The worker's dead-man's switch** (docs/project/observability.md § 2.4, alert A3).
 *
 * A process can be alive to pm2 and wedged — a poll that never returns, a pool that never hands
 * out a connection — and nothing on the box would say so. So the loop pings a Healthchecks.io
 * check from inside each iteration, and the *absence* of the ping is what alerts, from outside.
 *
 * At most once every {@link HEARTBEAT_INTERVAL_MS}, however fast the loop runs. Fire-and-forget:
 * a ping that cannot get out is logged and costs the loop nothing, because a heartbeat that could
 * stall the worker would be the failure it exists to detect. No URL means no ping, said once at
 * boot — a development machine has no check to ping.
 */

export const HEARTBEAT_URL_VARIABLE = 'HEALTHCHECK_WORKER_URL';

/** Five minutes: the check's period. The grace on top of it is the check's, not this file's. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/** The log message `verify:production`'s `heartbeat` check reads for, so a box can prove the loop beats. */
export const HEARTBEAT_SENT_MESSAGE = 'worker.heartbeat.sent';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface Heartbeat {
  /** Call from the loop as often as you like; it sends when it is due and otherwise does nothing. */
  beat(): void;
}

/** Whether a beat is due. Pure, so the interval is assertable without a clock. */
export function isHeartbeatDue(lastSentAt: number | null, now: number): boolean {
  return lastSentAt === null || now - lastSentAt >= HEARTBEAT_INTERVAL_MS;
}

/** The URL to ping, trimmed, or `null` when the deployment has none. */
export function readHeartbeatUrl(env: EnvSource): string | null {
  const configured = (env[HEARTBEAT_URL_VARIABLE] ?? '').trim();
  return configured === '' ? null : configured;
}

export interface HeartbeatOptions {
  readonly env?: EnvSource;
  readonly send?: (url: string) => Promise<unknown>;
  readonly now?: () => number;
}

export function createHeartbeat(options: HeartbeatOptions = {}): Heartbeat {
  const { env = process.env, send = defaultSend, now = Date.now } = options;
  const url = readHeartbeatUrl(env);
  if (url === null) {
    logger.info('worker.heartbeat.off', { reason: `${HEARTBEAT_URL_VARIABLE} is not set` });
    return { beat: () => undefined };
  }

  let lastSentAt: number | null = null;
  let inFlight = false;

  return {
    beat() {
      const at = now();
      if (inFlight || !isHeartbeatDue(lastSentAt, at)) return;
      inFlight = true;
      lastSentAt = at;
      void send(url)
        .then(() => {
          logger.info(HEARTBEAT_SENT_MESSAGE, {});
        })
        .catch((cause: unknown) => {
          logger.warn('worker.heartbeat.failed', {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          inFlight = false;
        });
    },
  };
}

async function defaultSend(url: string): Promise<void> {
  const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`the check answered ${response.status}`);
}
