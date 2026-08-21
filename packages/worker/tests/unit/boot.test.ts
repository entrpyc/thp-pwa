import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '@thp/shared/observability/logger';
import { SHUTDOWN_SIGNALS, checkEnvironment, installSignalHandlers } from '../../src/index';

/**
 * What the worker does before and after the loop: refuse to start without configuration, and stop
 * cleanly when asked.
 */
describe('the worker refuses to start without a database', () => {
  it('fails naming the variable, in the words the API uses', () => {
    // The same reader `@thp/db` gives the API — see packages/db/tests/unit/env.test.ts for the
    // sentence itself. What is asserted here is that the worker goes through it at boot rather
    // than discovering the problem as a driver error at the first poll.
    for (const env of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
      expect(() => checkEnvironment(env)).toThrowError(/DATABASE_URL is not set/);
    }
  });

  it('accepts a configured one', () => {
    expect(() => checkEnvironment({ DATABASE_URL: 'postgres://a:b@h:5432/d' })).not.toThrow();
  });
});

describe('SIGTERM and SIGINT ask the loop to stop', () => {
  // The handlers log; this suite is not the place to read that.
  let restoreSink: () => void;
  beforeAll(() => {
    restoreSink = setLogSink(() => {});
  });
  afterAll(() => restoreSink());

  it('registers a handler for both, and each one stops the loop', () => {
    const stop = vi.fn();
    const registered = new Map<string, () => void>();

    // An injectable registrar rather than a real signal: a signal emitted inside the test process
    // would be delivered to the runner as well, and on Windows one cannot be delivered to a child
    // process gracefully at all. What is under test is the wiring.
    installSignalHandlers(stop, (signal, handler) => registered.set(signal, handler));

    expect([...registered.keys()]).toEqual([...SHUTDOWN_SIGNALS]);

    for (const signal of SHUTDOWN_SIGNALS) registered.get(signal)?.();
    expect(stop).toHaveBeenCalledTimes(SHUTDOWN_SIGNALS.length);
  });

  it('stops rather than exits — the job in flight is finished first', () => {
    // The distinction the criterion turns on: the handler calls `stop`, and `stop` is what lets the
    // running job reach a terminal status. Nothing here calls `process.exit`; `main` does that
    // after `loop.done` resolves.
    const stop = vi.fn();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit must not be called by a signal handler');
    }) as never);

    try {
      const registered: (() => void)[] = [];
      installSignalHandlers(stop, (_signal, handler) => registered.push(handler));
      for (const handler of registered) handler();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
