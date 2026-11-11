import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_HEADER } from '@thp/shared';
import { ApiClientError } from '@/client/api-client';
import {
  applyAliases,
  replayRequests,
  rewriteAliases,
  setAliases,
  valueAt,
  type JsonFetch,
  type ReplayStore,
} from '@/client/offline/replay';
import type { QueuedRequest } from '@/client/offline/schema';

/**
 * **Sending what was done offline** ([3.18.18](docs/project/prd.md), [3.18.19](docs/project/prd.md)).
 *
 * The replay is driven with a list for a queue and a function for the server. What it has to get
 * right: order, the key that makes a re-send safe, real ids for things the device named, and the
 * three endings a send can have — accepted, refused, not reached.
 */

function queued(clientId: string, method: string, path: string, body: unknown, over: Partial<QueuedRequest> = {}): QueuedRequest {
  return {
    clientId,
    userId: 'u1',
    seq: Number(clientId.replace(/\D/g, '')) || 0,
    method,
    path,
    body,
    label: `Thing ${clientId}`,
    creates: [],
    coalesce: null,
    recordingId: null,
    at: '2026-11-11T10:00:00.000Z',
    ...over,
  };
}

function memoryStore(entries: QueuedRequest[], aliases: Record<string, string> = {}): ReplayStore & { held: QueuedRequest[]; aliases: Record<string, string> } {
  const state = {
    held: [...entries],
    aliases: { ...aliases },
    list: async () => [...state.held].sort((a, b) => a.seq - b.seq),
    remove: async (clientId: string) => {
      state.held = state.held.filter((one) => one.clientId !== clientId);
    },
    loadAliases: async () => ({ ...state.aliases }),
    saveAliases: async (_userId: string, next: Record<string, string>) => {
      state.aliases = { ...next };
    },
  };
  return state;
}

interface Sent {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly key: string | undefined;
}

function server(answer: (sent: Sent) => unknown): { fetchJson: JsonFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchJson = (async (path: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const one: Sent = {
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      key: headers[IDEMPOTENCY_KEY_HEADER],
    };
    sent.push(one);
    return answer(one);
  }) as JsonFetch;
  return { fetchJson, sent };
}

const keep = async (body: unknown) => body;

describe('reading an id out of an answer', () => {
  it('follows a dotted path, an index, and a list entry found by a field', () => {
    const body = { signal: { id: 's-real' }, session: { items: [{ id: 'i0' }, { id: 'i1' }] }, folders: [{ id: 'f9', name: 'Bible St.udy' }] };
    expect(valueAt(body, 'signal.id')).toBe('s-real');
    expect(valueAt(body, 'session.items.1.id')).toBe('i1');
    // A name may hold a dot, and is compared the way the server compares names.
    expect(valueAt(body, 'folders[name=bible st.udy].id')).toBe('f9');
    expect(valueAt(body, 'folders[name=Nope].id')).toBeNull();
    expect(valueAt(body, 'signal.missing.id')).toBeNull();
    expect(valueAt(body, '')).toBeNull();
  });
});

describe('replaying the queue', () => {
  it('sends each request as it was made, oldest first, under its own idempotency key', async () => {
    const store = memoryStore([
      queued('c2', 'DELETE', '/notes/n1/reaction', null),
      queued('c1', 'PUT', '/notes/n1/reaction', { emoji: '🙏' }),
    ]);
    const { fetchJson, sent } = server(() => ({}));
    const outcome = await replayRequests('u1', fetchJson, store, keep);
    expect(sent.map((one) => [one.method, one.path, one.key])).toEqual([
      ['PUT', '/notes/n1/reaction', 'c1'],
      ['DELETE', '/notes/n1/reaction', 'c2'],
    ]);
    expect(sent[0]?.body).toEqual({ emoji: '🙏' });
    expect(sent[1]?.body).toBeUndefined();
    expect(outcome).toMatchObject({ sent: 2, refusals: [], drained: true });
    expect(store.held).toEqual([]);
  });

  it('learns the real id of what was made offline and re-addresses what was queued after it', async () => {
    const store = memoryStore([
      queued('c1', 'POST', '/sos', { description: 'x' }, { creates: [{ temp: 'temp-signal', at: 'signal.id' }] }),
      queued('c2', 'PUT', '/sos/temp-signal/praying', { anonymous: false }),
      queued('c3', 'PUT', '/notes/n1/folders', { folderIds: ['temp-signal'] }),
    ]);
    const { fetchJson, sent } = server((one) => (one.path === '/sos' ? { signal: { id: 'real-signal' } } : {}));
    await replayRequests('u1', fetchJson, store, keep);
    expect(sent[1]?.path).toBe('/sos/real-signal/praying');
    expect(sent[2]?.body).toEqual({ folderIds: ['real-signal'] });
    // Kept beyond the replay: a screen still open on the device's id is re-addressed too.
    expect(store.aliases).toEqual({ 'temp-signal': 'real-signal' });
    expect(rewriteAliases('/sos/temp-signal')).toBe('/sos/real-signal');
    setAliases({});
  });

  it('drops a refused request with the server’s words, and silently everything that depended on it', async () => {
    const store = memoryStore([
      queued('c1', 'POST', '/sos', {}, { label: 'A prayer request', creates: [{ temp: 'temp-signal', at: 'signal.id' }] }),
      queued('c2', 'POST', '/sos/temp-signal/replies', { text: 'x' }, { creates: [{ temp: 'temp-reply', at: '' }] }),
      queued('c3', 'DELETE', '/sos/temp-signal/replies/temp-reply', null),
      queued('c4', 'PUT', '/notifications/n1/read', null),
    ]);
    const { fetchJson, sent } = server((one) => {
      if (one.path === '/sos') throw new ApiClientError('sos_limit', 409, 'You already have 10 open requests.', null);
      return {};
    });
    const outcome = await replayRequests('u1', fetchJson, store, keep);
    expect(sent.map((one) => one.path)).toEqual(['/sos', '/notifications/n1/read']);
    expect(outcome.refusals).toEqual(['A prayer request made offline could not be saved: You already have 10 open requests.']);
    expect(outcome.sent).toBe(1);
    expect(store.held).toEqual([]);
  });

  it('stops where the server cannot be reached and keeps the rest, in order, for the next connection', async () => {
    const store = memoryStore([
      queued('c1', 'PUT', '/notifications/n1/read', null),
      queued('c2', 'PUT', '/notifications/n2/read', null),
      queued('c3', 'PUT', '/notifications/n3/read', null),
    ]);
    const { fetchJson, sent } = server((one) => {
      if (one.path.includes('n2')) throw new TypeError('Failed to fetch');
      return {};
    });
    const outcome = await replayRequests('u1', fetchJson, store, keep);
    expect(sent).toHaveLength(2);
    expect(outcome).toMatchObject({ sent: 1, drained: false, refusals: [] });
    expect(store.held.map((one) => one.clientId)).toEqual(['c2', 'c3']);
  });

  it('treats a server that is failing, or a session that lapsed, as not reached rather than as a no', async () => {
    for (const status of [500, 503, 429, 401]) {
      const store = memoryStore([queued('c1', 'PUT', '/notifications/read', null)]);
      const { fetchJson } = server(() => {
        throw new ApiClientError('service_unavailable', status, 'later', null);
      });
      const outcome = await replayRequests('u1', fetchJson, store, keep);
      expect(outcome, String(status)).toMatchObject({ sent: 0, drained: false, refusals: [] });
      expect(store.held).toHaveLength(1);
    }
  });

  it('reports the teachings whose notes it changed, for the player to read again', async () => {
    const store = memoryStore([queued('c1', 'DELETE', '/notes/n1', null, { recordingId: 'r1' })]);
    const { fetchJson } = server(() => ({}));
    expect((await replayRequests('u1', fetchJson, store, keep)).touchedRecordings).toEqual(['r1']);
  });
});

describe('aliases', () => {
  it('replace every occurrence and leave other text alone', () => {
    expect(applyAliases('/a/t1/b/t1?x=t2', { t1: 'r1', t2: 'r2' })).toBe('/a/r1/b/r1?x=r2');
    expect(applyAliases('/a/b', { t1: 'r1' })).toBe('/a/b');
  });
});
