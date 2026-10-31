import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * **The push module's two handlers, without a browser** ([3.17.1](docs/project/prd.md),
 * [3.17.3](docs/project/prd.md)).
 *
 * `service-worker.test.ts` proves the module is loaded and registers both handlers; this file
 * drives them. A push with the dispatcher's payload shows the row's own words under its id; a
 * push that is not JSON still shows something, because a browser handed a push that shows
 * nothing may revoke the subscription. A press lands on the row's path in an open tab or a new
 * window, and a payload carrying anything but a path on this origin lands on the centre.
 */

const PUSH_MODULE = resolve(import.meta.dirname, '..', '..', 'public', 'sw', 'push.js');

type Handler = (event: Record<string, unknown>) => unknown;

function evaluatePushModule(windows: { url: string; focus: () => Promise<unknown>; navigate?: (url: string) => Promise<unknown> }[]) {
  const listeners = new Map<string, Handler>();
  const showNotification = vi.fn(() => Promise.resolve());
  const openWindow = vi.fn(() => Promise.resolve(null));
  const self = {
    location: { href: 'https://hub.test/sw.js', origin: 'https://hub.test' },
    registration: { showNotification },
    clients: { matchAll: vi.fn(() => Promise.resolve(windows)), openWindow },
    addEventListener(type: string, handler: Handler) {
      listeners.set(type, handler);
    },
  };
  runInNewContext(readFileSync(PUSH_MODULE, 'utf8'), { self, URL }, { filename: 'push.js' });
  return { listeners, showNotification, openWindow };
}

function pushEvent(data: unknown) {
  const waitUntil = vi.fn();
  return {
    event: {
      data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) },
      waitUntil,
    },
    waitUntil,
  };
}

async function settle(waitUntil: ReturnType<typeof vi.fn>): Promise<void> {
  await Promise.all(waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>));
}

describe('a push arriving', () => {
  it('shows the row\'s words under its id, with the path for the press', async () => {
    const worker = evaluatePushModule([]);
    const { event, waitUntil } = pushEvent({
      notificationId: 'n-1',
      kind: 'note_reply',
      title: 'Ana replied to your note',
      body: 'A line of the reply',
      href: '/recordings/r-1',
    });
    worker.listeners.get('push')?.(event);
    await settle(waitUntil);
    expect(worker.showNotification).toHaveBeenCalledWith('Ana replied to your note', expect.objectContaining({
      body: 'A line of the reply',
      tag: 'n-1',
      icon: '/icons/icon-192.png',
      data: { href: '/recordings/r-1', kind: 'note_reply' },
    }));
  });

  it('lands an announcement, which has no destination, on the centre', async () => {
    const worker = evaluatePushModule([]);
    const { event, waitUntil } = pushEvent({ notificationId: 'n-2', kind: 'announcement', title: 'Hello', body: 'From the admins.', href: null });
    worker.listeners.get('push')?.(event);
    await settle(waitUntil);
    expect(worker.showNotification).toHaveBeenCalledWith('Hello', expect.objectContaining({ data: { href: '/notifications', kind: 'announcement' } }));
  });

  it('still shows something for a payload that is not what the dispatcher sends', async () => {
    const worker = evaluatePushModule([]);
    const broken = { event: { data: { json: () => { throw new SyntaxError('not json'); } }, waitUntil: vi.fn() } };
    worker.listeners.get('push')?.(broken.event);
    await settle(broken.event.waitUntil);
    expect(worker.showNotification).toHaveBeenCalledWith('Vinegard', expect.objectContaining({ body: '', data: { href: '/notifications', kind: null } }));

    const empty = pushEvent(undefined);
    worker.listeners.get('push')?.(empty.event);
    await settle(empty.waitUntil);
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
  });
});

describe('a press on the notification', () => {
  function click(worker: ReturnType<typeof evaluatePushModule>, href: unknown) {
    const close = vi.fn();
    const waitUntil = vi.fn();
    worker.listeners.get('notificationclick')?.({ notification: { close, data: { href } }, waitUntil });
    return { close, waitUntil };
  }

  it('focuses an open tab of the app and navigates it to the path', async () => {
    const navigate = vi.fn(() => Promise.resolve());
    const tab = { url: 'https://hub.test/recordings', focus: vi.fn(), navigate };
    tab.focus.mockImplementation(() => Promise.resolve(tab));
    const worker = evaluatePushModule([{ url: 'https://elsewhere.test/', focus: () => Promise.resolve() }, tab]);

    const { close, waitUntil } = click(worker, '/recordings/r-1');
    await settle(waitUntil);
    expect(close).toHaveBeenCalledTimes(1);
    expect(tab.focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('https://hub.test/recordings/r-1');
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window when no tab of the app is open', async () => {
    const worker = evaluatePushModule([]);
    const { waitUntil } = click(worker, '/recordings/r-1');
    await settle(waitUntil);
    expect(worker.openWindow).toHaveBeenCalledWith('https://hub.test/recordings/r-1');
  });

  it('refuses to land anywhere but a path on this origin', async () => {
    const worker = evaluatePushModule([]);
    for (const bad of ['https://evil.test/x', '//evil.test/x', null, 42]) {
      const { waitUntil } = click(worker, bad);
      await settle(waitUntil);
    }
    expect(worker.openWindow.mock.calls.map((call) => (call as unknown[])[0])).toEqual(Array(4).fill('https://hub.test/notifications'));
  });
});
