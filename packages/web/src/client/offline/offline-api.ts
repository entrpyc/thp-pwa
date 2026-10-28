import {
  API_PREFIX,
  AUTH_SESSION_PATH,
  LIBRARY_SURFACE,
  RECORDING_SURFACE_PARAM,
  type CreateNoteRequest,
  type NoteImageRef,
  type NoteImageView,
  type NoteView,
  type PlaybackProgressPayload,
  type SeriesRecordingView,
  type SeriesView,
  type SessionPayload,
} from '@thp/shared';
import type { OfflineHooks } from '@/client/api-client';
import { idbAllBy, idbGet, idbPut, idbUpdate } from './idb';
import { mintClientId } from './outbox';
import {
  ACTIVE_USER_KEY,
  BY_USER_INDEX,
  OFFLINE_STORES,
  downloadKey,
  sessionMetaKey,
  type DownloadRecord,
  type OutboxRecord,
  type PendingImageRecord,
} from './schema';

/**
 * **The API, answered from the device** ([3.18.3](docs/project/prd.md), [3.18.4](docs/project/prd.md),
 * [3.18.13](docs/project/prd.md), [3.18.15](docs/project/prd.md)).
 *
 * When `fetch` cannot reach the server, the API client hands the request here (`installOfflineHooks`).
 * The library answers with the downloaded teachings only, a series with its downloaded teachings,
 * and a downloaded teaching with the chapters, scripture and notes stored beside its bytes — plus
 * the notes still in the outbox, drawn as the member's own. A note written offline becomes an
 * outbox entry and answers `201` with that pending copy, so the composer behaves as it does online
 * without being edited. Everything else answers the API's own error envelope with
 * `service_unavailable`, which every screen already reads as "could not reach the server".
 *
 * **In the page rather than in the service worker**, and the reason is the test suite as much as
 * the product: the screens' failure paths are driven by Playwright stubbing the page's requests,
 * and a worker that proxied every API read would answer those stubs from the network. The worker
 * keeps what only it can do — pages and chunks for a cold start — and the page keeps what it can
 * do itself. Both read one IndexedDB.
 *
 * The decisions are pure functions over a {@link Snapshot}, so the unit test drives them without a
 * database; the hooks at the bottom are the thin wiring to IndexedDB.
 */

export interface Snapshot {
  readonly userId: string | null;
  readonly downloads: readonly DownloadRecord[];
  readonly outbox: readonly OutboxRecord[];
  readonly session: SessionPayload | null;
  /** The pictures waiting on a connection, so a pending note can show its own. Empty when unread. */
  readonly pendingImages?: readonly PendingImageRecord[];
}

export type OfflineRoute =
  | { readonly name: 'series-list' }
  | { readonly name: 'resume' }
  | { readonly name: 'session' }
  | { readonly name: 'series'; readonly id: string }
  | {
      readonly name: 'recording' | 'chapters' | 'scripture' | 'notes' | 'progress';
      readonly id: string;
      readonly chapter: string | null;
    };

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** Which offline-answerable read a path is, or `null`. The path is relative to the API prefix. */
export function apiRoute(path: string): OfflineRoute | null {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, 'https://offline.invalid');
  const rest = url.pathname;
  const library = url.searchParams.get(RECORDING_SURFACE_PARAM) === LIBRARY_SURFACE;
  if (rest === '/series' && library) return { name: 'series-list' };
  if (rest === '/recordings/resume') return { name: 'resume' };
  if (rest === AUTH_SESSION_PATH) return { name: 'session' };
  const series = /^\/series\/([^/]+)$/.exec(rest);
  if (series?.[1] !== undefined) return { name: 'series', id: series[1] };
  const recording = /^\/recordings\/([^/]+)(?:\/(chapters|scripture|notes|progress))?$/.exec(rest);
  if (recording?.[1] !== undefined) {
    const sub = recording[2] as 'chapters' | 'scripture' | 'notes' | 'progress' | undefined;
    return { name: sub ?? 'recording', id: recording[1], chapter: url.searchParams.get('chapter') };
  }
  return null;
}

/** The newest pending position for a teaching wins over the one stored with the download. */
export function positionFor(download: DownloadRecord, outbox: readonly OutboxRecord[]): number | null {
  const pending = outbox
    .filter((entry) => entry.kind === 'progress' && entry.recordingId === download.recordingId)
    .sort((a, b) => b.at.localeCompare(a.at));
  const newest = pending[0];
  if (newest !== undefined) return (newest.body as { positionMs: number }).positionMs;
  return download.progress?.positionMs ?? null;
}

/** A note that exists on this device only, drawn as the member's own until the flush replaces it. */
export function pendingNote(
  entry: OutboxRecord,
  session: SessionPayload | null,
  pendingImages: readonly PendingImageRecord[] = [],
): NoteView {
  const body = entry.body as CreateNoteRequest;
  // The pictures kept on the device, drawn from their own bytes until the flush uploads them. One
  // already uploaded (a key) cannot be shown offline — its URL is the server's to sign — and is
  // left out rather than drawn broken.
  const images: NoteImageView[] = (body.images ?? []).flatMap((ref) => {
    if (!('pending' in ref)) return [];
    const kept = pendingImages.find((one) => one.id === ref.pending);
    if (kept === undefined || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return [];
    return [{ id: `pending:${ref.pending}`, url: URL.createObjectURL(kept.blob), alt: ref.alt ?? null }];
  });
  return {
    id: `pending:${entry.clientId}`,
    timestampMs: body.timestampMs,
    authorId: entry.userId,
    authorDisplayName: session?.user.displayName ?? 'You',
    authorAvatarUrl: session?.user.avatarUrl ?? null,
    visibility: body.visibility,
    mine: true,
    text: body.text,
    createdAt: entry.at,
    deleted: false,
    pinned: false,
    replies: [],
    reactions: [],
    myReaction: null,
    images,
  };
}

/** The series the held teachings belong to, as the series listing draws them. */
function seriesViews(held: readonly DownloadRecord[]): SeriesView[] {
  const groups = new Map<string, DownloadRecord[]>();
  for (const one of held) {
    if (one.seriesId === null) continue;
    groups.set(one.seriesId, [...(groups.get(one.seriesId) ?? []), one]);
  }
  return [...groups.entries()].map(([id, members]) => {
    const dates = members.map((one) => one.recordedAt).sort();
    const first = members[0];
    return {
      id,
      title: first?.seriesTitle ?? '',
      artworkUrl: first?.recording.series?.artworkUrl ?? null,
      description: null,
      recordingCount: members.length,
      firstRecordedAt: dates[0] ?? null,
      lastRecordedAt: dates[dates.length - 1] ?? null,
      tags: [],
    };
  });
}

/**
 * The offline answer for a read: `{ status, body }`, or `null` when nothing held can answer it.
 * Only this member's downloads count, newest recorded first — the library's own order.
 */
export function offlineAnswer(route: OfflineRoute, snapshot: Snapshot): Answer | null {
  const held = snapshot.downloads
    .filter((one) => one.userId === snapshot.userId)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const outbox = snapshot.outbox.filter((one) => one.userId === snapshot.userId);
  const one = 'id' in route ? held.find((d) => d.recordingId === route.id) ?? null : null;

  switch (route.name) {
    case 'resume':
      return { status: 200, body: { resume: null } };
    case 'session':
      return snapshot.session === null ? null : { status: 200, body: snapshot.session };
    case 'series-list':
      return { status: 200, body: { series: seriesViews(held) } };
    case 'series': {
      const view = seriesViews(held).find((s) => s.id === route.id);
      if (view === undefined) return null;
      const recordings: SeriesRecordingView[] = held
        .filter((d) => d.seriesId === route.id)
        .map((d) => ({
          id: d.recordingId,
          title: d.title,
          description: d.recording.description,
          recordedAt: d.recordedAt,
          positionMs: positionFor(d, outbox),
        }));
      return { status: 200, body: { series: view, recordings } };
    }
    case 'recording':
      return one === null ? null : { status: 200, body: { recording: one.recording } };
    case 'chapters':
      return one === null ? null : { status: 200, body: { chapters: one.chapters } };
    case 'scripture':
      return one === null ? null : { status: 200, body: { references: one.scripture } };
    case 'notes': {
      if (one === null) return null;
      const pending = outbox
        .filter((entry) => entry.kind === 'note' && entry.recordingId === route.id)
        .map((entry) => pendingNote(entry, snapshot.session, snapshot.pendingImages ?? []));
      let notes = [...one.notes, ...pending].sort(
        (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0),
      );
      if (route.chapter !== null) {
        const index = one.chapters.findIndex((c) => c.id === route.chapter);
        const chapter = one.chapters[index];
        if (chapter !== undefined) {
          const next = one.chapters[index + 1];
          notes = notes.filter(
            (n) =>
              n.timestampMs !== null &&
              n.timestampMs >= chapter.startMs &&
              (next === undefined || n.timestampMs < next.startMs),
          );
        }
      }
      return { status: 200, body: { notes } };
    }
    case 'progress': {
      if (one === null) return null;
      const body: PlaybackProgressPayload = {
        positionMs: positionFor(one, outbox),
        updatedAt: one.progress?.updatedAt ?? null,
        completedAt: one.progress?.completedAt ?? null,
      };
      return { status: 200, body };
    }
    default:
      return null;
  }
}

/** The API's own error envelope, as the client reads it: "could not reach the server". */
export function offlineError(message: string): Answer {
  return {
    status: 503,
    body: { error: { code: 'service_unavailable', message, correlationId: 'offline' } },
  };
}

/**
 * What an offline `POST .../notes` becomes: an outbox entry and the pending note to answer with,
 * or a refusal. A reply needs its parent live, and a note on a teaching not held has nowhere to be
 * read back from; both are refused rather than queued.
 */
export function offlineNoteWrite(
  recordingId: string,
  body: unknown,
  snapshot: Snapshot,
): { readonly entry: OutboxRecord; readonly answer: Answer } | { readonly answer: Answer } {
  if (snapshot.userId === null || typeof body !== 'object' || body === null) {
    return { answer: offlineError('You are offline.') };
  }
  const fields = body as Partial<CreateNoteRequest> & { parentId?: unknown };
  if (fields.parentId !== undefined && fields.parentId !== null) {
    return { answer: offlineError('Replies need a connection. Try again when you are back online.') };
  }
  const held = snapshot.downloads.some(
    (d) => d.userId === snapshot.userId && d.recordingId === recordingId,
  );
  if (!held) return { answer: offlineError('You are offline, and this teaching is not downloaded.') };
  if (typeof fields.text !== 'string' || typeof fields.timestampMs !== 'number' || (fields.visibility !== 'public' && fields.visibility !== 'private')) {
    return { answer: offlineError('You are offline.') };
  }
  // Pictures travel as the body named them: a pending id for bytes kept on the device, or a key
  // for one that was uploaded before the connection went. The flush turns the first into the
  // second before the note leaves the device.
  const images = pendingImageRefs(fields.images);
  if (images === null) return { answer: offlineError('You are offline.') };
  if (fields.text.trim() === '' && images.length === 0) return { answer: offlineError('You are offline.') };
  const entry: OutboxRecord = {
    clientId: mintClientId(),
    userId: snapshot.userId,
    kind: 'note',
    recordingId,
    at: new Date().toISOString(),
    body: {
      text: fields.text,
      visibility: fields.visibility,
      timestampMs: fields.timestampMs,
      ...(images.length === 0 ? {} : { images }),
    },
  };
  return {
    entry,
    answer: { status: 201, body: { note: pendingNote(entry, snapshot.session, snapshot.pendingImages ?? []) } },
  };
}

/** Which stored field an online answer refreshes, by route. */
/** The `images` of an offline note body, read and kept as sent — or `null` when it is not a list of references. */
function pendingImageRefs(value: unknown): NoteImageRef[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) return null;
  const refs: NoteImageRef[] = [];
  for (const one of value as unknown[]) {
    if (typeof one !== 'object' || one === null) return null;
    const ref = one as { pending?: unknown; key?: unknown; alt?: unknown };
    const alt = typeof ref.alt === 'string' && ref.alt.trim() !== '' ? ref.alt.trim() : null;
    if (typeof ref.pending === 'string') refs.push({ pending: ref.pending, alt });
    else if (typeof ref.key === 'string') refs.push({ key: ref.key, alt });
    else return null;
  }
  return refs;
}

const REFRESHED: Partial<Record<OfflineRoute['name'], { field: keyof DownloadRecord; key: string | null }>> = {
  recording: { field: 'recording', key: 'recording' },
  chapters: { field: 'chapters', key: 'chapters' },
  scripture: { field: 'scripture', key: 'references' },
  notes: { field: 'notes', key: 'notes' },
  progress: { field: 'progress', key: null },
};

// =================================================================================================
// Wiring to IndexedDB
// =================================================================================================

function jsonResponse(answer: Answer): Response {
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json', 'x-thp-offline': '1' },
  });
}

async function snapshotFor(): Promise<Snapshot> {
  const active = await idbGet<{ userId: string | null }>(OFFLINE_STORES.meta, ACTIVE_USER_KEY);
  const userId = active?.userId ?? null;
  if (userId === null) return { userId: null, downloads: [], outbox: [], session: null };
  const [downloads, outbox, session, pendingImages] = await Promise.all([
    idbAllBy<DownloadRecord>(OFFLINE_STORES.downloads, BY_USER_INDEX, userId),
    idbAllBy<OutboxRecord>(OFFLINE_STORES.outbox, BY_USER_INDEX, userId),
    idbGet<SessionPayload>(OFFLINE_STORES.meta, sessionMetaKey(userId)),
    idbAllBy<PendingImageRecord>(OFFLINE_STORES.noteImages, BY_USER_INDEX, userId).catch(() => []),
  ]);
  return { userId, downloads, outbox, session: session ?? null, pendingImages };
}

/**
 * The hooks the member surface installs on the API client. `onOutboxWrite` lets the manager
 * re-count the outbox after a note was kept; `onDownloadRefreshed` lets it re-read a download
 * whose stored copy changed.
 */
export function createOfflineHooks(events: {
  onOutboxWrite(): void;
  onDownloadRefreshed(): void;
}): OfflineHooks {
  return {
    async fallback({ path, init }) {
      const method = (init.method ?? 'GET').toUpperCase();
      let snapshot: Snapshot;
      try {
        snapshot = await snapshotFor();
      } catch {
        return null;
      }
      if (method === 'GET') {
        const route = apiRoute(path);
        if (route === null) return null;
        const answer = offlineAnswer(route, snapshot);
        if (answer !== null) return jsonResponse(answer);
        if (route.name === 'session' || route.name === 'resume') return null;
        return jsonResponse(offlineError('You are offline, and this teaching is not downloaded.'));
      }
      if (method === 'POST') {
        const match = /^\/recordings\/([^/?]+)\/notes$/.exec(path);
        if (match?.[1] === undefined) return null;
        let body: unknown = null;
        try {
          body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        } catch {
          body = null;
        }
        const result = offlineNoteWrite(match[1], body, snapshot);
        if ('entry' in result) {
          try {
            await idbPut(OFFLINE_STORES.outbox, result.entry);
          } catch {
            return jsonResponse(offlineError('You are offline, and the note could not be kept on this device.'));
          }
          events.onOutboxWrite();
        }
        return jsonResponse(result.answer);
      }
      return null;
    },

    observe({ path, method, body }) {
      if (method !== 'GET' || typeof body !== 'object' || body === null) return;
      const route = apiRoute(path);
      if (route === null) return;
      void (async () => {
        const active = await idbGet<{ userId: string | null }>(OFFLINE_STORES.meta, ACTIVE_USER_KEY);
        const userId = active?.userId ?? null;
        if (userId === null) return;
        if (route.name === 'session') {
          const payload = body as Partial<SessionPayload>;
          if (payload.user?.id === userId) await idbPut(OFFLINE_STORES.meta, payload, sessionMetaKey(userId));
          return;
        }
        if (!('id' in route) || route.name === 'series') return;
        if (route.chapter !== null) return;
        const refresh = REFRESHED[route.name];
        if (refresh === undefined) return;
        const value = refresh.key === null ? body : (body as Record<string, unknown>)[refresh.key];
        if (value === undefined) return;
        // One transaction for the read and the write, so a download deleted in between stays
        // deleted rather than being written back by a late answer.
        const refreshed = await idbUpdate<DownloadRecord>(
          OFFLINE_STORES.downloads,
          downloadKey(userId, route.id),
          (record) => ({ ...record, [refresh.field]: value }),
        );
        if (refreshed) events.onDownloadRefreshed();
      })().catch(() => undefined);
    },
  };
}

/** Exported for the tests: the prefix the hooks' paths are relative to. */
export const OFFLINE_API_PREFIX = API_PREFIX;
