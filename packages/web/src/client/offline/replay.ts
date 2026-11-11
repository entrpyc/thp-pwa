import {
  IDEMPOTENCY_KEY_HEADER,
  NOTE_IMAGE_UPLOADS_PATH,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError } from '@/client/api-client';
import { idbAllBy, idbDelete, idbGet, idbPut } from './idb';
import {
  BY_USER_INDEX,
  OFFLINE_STORES,
  aliasesMetaKey,
  type PendingImageRecord,
  type QueuedRequest,
} from './schema';

/**
 * **Sending what was done offline** ([3.18.18](docs/project/prd.md), [3.18.19](docs/project/prd.md)).
 *
 * A queued request is the request the screen made, kept whole. Replay sends each one to the route
 * it was made for, oldest first, and reads the server's answer as the truth:
 *
 * - **Accepted** — it is done, and removed from the queue. If it created something the device had
 *   minted an id for, the real id is read out of the answer and remembered as an *alias*, and
 *   every later request that names the device's id is re-addressed before it is sent.
 * - **Refused** (the server answered, and said no) — it is removed and the member is told, in the
 *   server's words. A note removed in the meantime, a prayer request since closed: the device
 *   could not have known. Anything queued that depended on a creation that was refused is dropped
 *   with it, silently — one sentence about the cause is enough.
 * - **Not reached** — replay stops there and the rest waits for the next connection, in order.
 *
 * **Each send carries the request's own id as an idempotency key.** The server keeps the first
 * successful answer under it (`request-receipts.ts`), so a send whose answer was lost on the way
 * back is answered the same way the second time, and nothing is applied twice.
 *
 * The aliases outlive the replay: a screen left open on a prayer request raised offline still
 * holds the device's id, and {@link rewriteAliases} re-addresses what it sends next.
 */

export type JsonFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ReplayStore {
  list(userId: string): Promise<QueuedRequest[]>;
  remove(clientId: string): Promise<void>;
  loadAliases(userId: string): Promise<Record<string, string>>;
  saveAliases(userId: string, aliases: Record<string, string>): Promise<void>;
}

export interface ReplayOutcome {
  readonly sent: number;
  /** One sentence per request the server refused. */
  readonly refusals: readonly string[];
  /** Teachings whose notes a sent request changed. */
  readonly touchedRecordings: readonly string[];
  /** Whether the queue is now empty: `false` when the server could not be reached partway. */
  readonly drained: boolean;
}

/** The queue, oldest first. */
export async function listRequests(userId: string): Promise<QueuedRequest[]> {
  const held = await idbAllBy<QueuedRequest>(OFFLINE_STORES.requests, BY_USER_INDEX, userId);
  return held.sort((a, b) => a.seq - b.seq);
}

export async function countRequests(userId: string): Promise<number> {
  return (await idbAllBy<QueuedRequest>(OFFLINE_STORES.requests, BY_USER_INDEX, userId)).length;
}

export const idbReplayStore: ReplayStore = {
  list: listRequests,
  remove: (clientId) => idbDelete(OFFLINE_STORES.requests, clientId),
  loadAliases: async (userId) =>
    (await idbGet<Record<string, string>>(OFFLINE_STORES.meta, aliasesMetaKey(userId))) ?? {},
  saveAliases: (userId, aliases) => idbPut(OFFLINE_STORES.meta, aliases, aliasesMetaKey(userId)),
};

// ------------------------------------------------------------------------------------- aliases

let aliases: Record<string, string> = {};

/** Name the device-minted ids the server has given real ones to. Called at activation and after a replay. */
export function setAliases(next: Record<string, string>): void {
  aliases = { ...next };
}

/** Every device-minted id in `text` replaced by the real one. Text without one is returned as-is. */
export function applyAliases(text: string, map: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [temp, real] of Object.entries(map)) {
    if (out.includes(temp)) out = out.split(temp).join(real);
  }
  return out;
}

/** What the API client runs every outgoing path and body through. */
export function rewriteAliases(text: string): string {
  return applyAliases(text, aliases);
}

/**
 * The value at a dotted path in an answer — `signal.id`, `session.items.3.id` — or
 * `folders[name=Prayer].id`, which finds the entry of a list by a field. `null` when it is not
 * there or is not a string.
 */
export function valueAt(body: unknown, at: string): string | null {
  if (at === '') return null;
  let current: unknown = body;
  // A `[field=value]` selector may hold dots (a folder's name), so it is cut out before the split.
  const parts: string[] = [];
  let rest = at;
  while (rest !== '') {
    const selector = /^([^.[\]]+)\[([^=\]]+)=([^\]]*)\]\.?/.exec(rest);
    if (selector !== null) {
      parts.push(selector[1] as string, `[${selector[2] as string}=${selector[3] as string}]`);
      rest = rest.slice(selector[0].length);
      continue;
    }
    const dot = rest.indexOf('.');
    parts.push(dot === -1 ? rest : rest.slice(0, dot));
    rest = dot === -1 ? '' : rest.slice(dot + 1);
  }
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    const selector = /^\[([^=]+)=(.*)\]$/.exec(part);
    if (selector !== null) {
      if (!Array.isArray(current)) return null;
      const [, field, value] = selector;
      current = (current as unknown[]).find(
        (one) =>
          typeof one === 'object' &&
          one !== null &&
          String((one as Record<string, unknown>)[field as string]).toLowerCase() === (value as string).toLowerCase(),
      );
      continue;
    }
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

// --------------------------------------------------------------------------------------- pictures

/**
 * A reply or an edit written offline may name pictures kept on the device (`pending`). The server
 * takes keys, so each is uploaded first and its reference replaced. A picture whose bytes are
 * gone is left out; an upload that fails throws, which the caller reads as "not reached".
 */
async function withPicturesUploaded(body: unknown, fetchJson: JsonFetch): Promise<unknown> {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { images?: unknown }).images)) return body;
  const refs = (body as { images: unknown[] }).images;
  if (!refs.some((one) => typeof one === 'object' && one !== null && 'pending' in one)) return body;
  const next: unknown[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'object' || ref === null || !('pending' in ref)) {
      next.push(ref);
      continue;
    }
    const pending = (ref as { pending: string; alt?: string | null }).pending;
    const kept = await idbGet<PendingImageRecord>(OFFLINE_STORES.noteImages, pending).catch(() => undefined);
    if (kept === undefined) continue;
    const grant = await fetchJson<UploadGrantPayload>(NOTE_IMAGE_UPLOADS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: `${pending}.webp`, contentType: kept.contentType, size: kept.blob.size }),
    });
    const put = await fetch(grant.url, { method: 'PUT', headers: { 'content-type': grant.contentType }, body: kept.blob });
    if (!put.ok) throw new Error('the upload did not complete');
    next.push({ key: grant.key, alt: (ref as { alt?: string | null }).alt ?? kept.alt ?? null });
    await idbDelete(OFFLINE_STORES.noteImages, pending).catch(() => undefined);
  }
  return { ...(body as Record<string, unknown>), images: next };
}

// ----------------------------------------------------------------------------------------- replay

/** A server answer that means "try again later" rather than "no". */
function isTransient(error: ApiClientError): boolean {
  return error.status >= 500 || error.status === 429 || error.status === 401;
}

export async function replayRequests(
  userId: string,
  fetchJson: JsonFetch,
  store: ReplayStore = idbReplayStore,
  preparePictures: (body: unknown, fetchJson: JsonFetch) => Promise<unknown> = withPicturesUploaded,
): Promise<ReplayOutcome> {
  const queue = await store.list(userId);
  const known = await store.loadAliases(userId);
  const refusals: string[] = [];
  const touched = new Set<string>();
  /** Device-minted ids whose creation the server refused: what names one is dropped with it. */
  const failed = new Set<string>();
  let sent = 0;
  let drained = true;

  for (const entry of queue) {
    const raw = `${entry.path}\n${entry.body === null || entry.body === undefined ? '' : JSON.stringify(entry.body)}`;
    if ([...failed].some((temp) => raw.includes(temp))) {
      await store.remove(entry.clientId);
      for (const made of entry.creates) failed.add(made.temp);
      continue;
    }
    const path = applyAliases(entry.path, known);
    try {
      const prepared = await preparePictures(entry.body, fetchJson);
      const body =
        prepared === null || prepared === undefined ? undefined : applyAliases(JSON.stringify(prepared), known);
      const answer = await fetchJson<unknown>(path, {
        method: entry.method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          [IDEMPOTENCY_KEY_HEADER]: entry.clientId,
        },
        ...(body === undefined ? {} : { body }),
      });
      for (const made of entry.creates) {
        const real = valueAt(answer, made.at);
        if (real !== null && real !== made.temp) known[made.temp] = real;
      }
      await store.remove(entry.clientId);
      sent += 1;
      if (entry.recordingId !== null) touched.add(entry.recordingId);
    } catch (caught) {
      if (caught instanceof ApiClientError && !isTransient(caught)) {
        await store.remove(entry.clientId);
        for (const made of entry.creates) failed.add(made.temp);
        refusals.push(`${entry.label} made offline could not be saved: ${caught.message}`);
        continue;
      }
      // Not reached, or not now: this one and everything after it wait, in order.
      drained = false;
      break;
    }
  }

  await store.saveAliases(userId, known).catch(() => undefined);
  setAliases(known);
  return { sent, refusals, touchedRecordings: [...touched], drained };
}
