import { pathToFileURL } from 'node:url';
import { closeDatabase, requireDatabaseUrl, type EnvSource } from '@thp/db';
import { logger } from '@thp/shared/observability/logger';
import { createHandlers } from './handlers';
import { startWorkerLoop } from './loop';
import { sweepAbandonedJobs } from './sweep';

/**
 * The worker process — `npm run worker`.
 *
 * A second process against the same database, and **the first thing in this repository that runs
 * without a request behind it.** Three things happen at boot, in this order:
 *
 * 1. **The environment is checked.** `DATABASE_URL` is read through the same reader the API uses,
 *    so a missing variable fails here, by name, rather than as a driver error at the first poll.
 * 2. **The sweep takes back what the last run left in flight** (see sweep.ts). Before any claiming,
 *    because a job this process is about to claim must not be one it then decides was abandoned.
 * 3. **The loop starts** and polls until a signal stops it.
 *
 * Nothing restarts it if it exits — supervision, restart-on-failure and start-on-boot are Story 7.
 * It is started by hand, in a second terminal, beside the app.
 */

/** The two ways a person or an init system asks this process to stop. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type SignalRegistrar = (signal: NodeJS.Signals, handler: () => void) => void;

/**
 * Fail now, by name, if the process cannot possibly work.
 *
 * The same reader `@thp/db` uses for the API — shared rather than restated, so "the worker says the
 * same sentence about the same variable" is a fact rather than a coincidence.
 */
export function checkEnvironment(env: EnvSource = process.env): void {
  requireDatabaseUrl(env);
}

/**
 * **Stop claiming, let the job in flight finish, exit 0.**
 *
 * Not an immediate exit: a job killed mid-run is a row left `running` that only the next boot's
 * sweep can explain, and asking for a clean stop should not produce one. The handler is registered
 * through an injectable registrar so the wiring can be driven in a test without a real signal —
 * which on Windows cannot be delivered to a child process gracefully anyway.
 */
export function installSignalHandlers(stop: () => void, on: SignalRegistrar = defaultOn): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    on(signal, () => {
      logger.info('worker.signal', { signal });
      stop();
    });
  }
}

const defaultOn: SignalRegistrar = (signal, handler) => {
  process.on(signal, handler);
};

export async function main(): Promise<void> {
  checkEnvironment();
  await sweepAbandonedJobs();

  const loop = startWorkerLoop({ handlers: createHandlers() });
  installSignalHandlers(loop.stop);

  await loop.done;
  await closeDatabase();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    () => {
      process.exit(0);
    },
    (cause: unknown) => {
      logger.error('worker.failed', {
        error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      });
      process.exit(1);
    },
  );
}
