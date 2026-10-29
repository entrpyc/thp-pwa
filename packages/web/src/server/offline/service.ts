import {
  findSyncReceipts,
  findVisibleRecording,
  findVisibleSeries,
  insertSyncReceipt,
  listVisibleRecordings,
  type SyncReceiptRow,
} from '@thp/db';
import { mediaStore } from '@thp/media';
import {
  MAX_SYNC_DOWNLOADED,
  MAX_SYNC_ENTRIES,
  SYNC_ENTRY_KINDS,
  isClientId,
  type CreateNoteRequest,
  type DownloadGrantPayload,
  type NoteView,
  type PlaybackProgressRequest,
  type SeriesDownloadItem,
  type SeriesDownloadPayload,
  type SyncEntry,
  type SyncEntryKind,
  type SyncEntryResult,
  type SyncPayload,
  type SyncRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { createNote } from '@/server/notes/service';
import { logger } from '@/server/observability/logger';
import { PLAYBACK_GRANT_SECONDS } from '@/server/playback/grant';
import { writePlaybackProgress } from '@/server/playback/state';

/**
 * **Downloads and offline sync, server side** ([3.18](docs/project/prd.md); project tdd 5.2, 5.3).
 *
 * Three things, and each is deliberately a thin layer over something that already exists:
 *
 * - {@link mintDownloadGrant} is the playback grant with the object's size beside it. It reads the
 *   same visibility condition and the same key preference as `mintPlaybackGrant` — the rendition
 *   when there is one, the original otherwise — so a download is byte-for-byte what the player
 *   would have streamed. It is a second function rather than a flag on the first because the first
 *   is reserved for the player by its own header, and because a size costs a `HEAD` to the store
 *   that playback must never pay.
 * - {@link describeSeriesDownload} answers "Download all" with every published recording's size,
 *   so the browser route can refuse before it starts (3.18.17) and the store route can confirm the
 *   total (the operator's decision: a single teaching downloads on one tap, a series asks first).
 * - {@link syncOutbox} applies an outbox through the **live services** — `writePlaybackProgress`,
 *   `createNote` — never through a second code path. Everything the live route would refuse, this
 *   refuses with the same code and message, and the client reads the result exactly as it would
 *   have read the response had it been online. What this adds is the receipt (tdd 5.3's client id)
 *   and the revocation list (3.18.12).
 */

/** An error code the sync result can carry: whatever `ApiError` carries. */
type Refusal = { readonly code: SyncEntryResult['code']; readonly message: string };

export async function mintDownloadGrant(
  actor: Actor,
  recordingId: string,
): Promise<DownloadGrantPayload> {
  const row = await findVisibleRecording(recordingId, { includeUnpublished: false });
  if (row === null) {
    logger.warn('recording.download.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${recordingId}`,
      reason: 'not-published',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  const mediaKey = row.playbackMediaKey ?? row.originalMediaKey;
  const stored = await mediaStore().head(mediaKey);
  if (stored === null) {
    // The row names an object the store does not hold. Not the member's fault and not something a
    // retry fixes; the operator finds it by the key in the log.
    logger.error('recording.download.missing-object', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${row.id}`,
      mediaKey,
    });
    throw ApiError.serviceUnavailable('The audio for this teaching is not available right now.');
  }

  const expiresAt = new Date(Date.now() + PLAYBACK_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignGet({
    key: mediaKey,
    expiresInSeconds: PLAYBACK_GRANT_SECONDS,
  });

  // The paid path, counted: one line per full fetch of a recording is what the egress story is
  // read from (docs/project/tdd.md 8), and the key is logged, never returned.
  logger.info('recording.download.granted', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${row.id}`,
    mediaKey,
    bytes: stored.size,
    expiresAt: expiresAt.toISOString(),
  });

  return { url, expiresAt: expiresAt.toISOString(), bytes: stored.size, contentType: stored.contentType };
}

/**
 * Every published recording of a series with its size, newest recorded first — the series page's
 * own order, so "the most recent recordings that do fit" is a prefix of this list.
 *
 * One `HEAD` per recording. A series is a dozen teachings and this is asked once per press of
 * "Download all", so the round trips are cheaper than a size column every upload and every
 * rendition would have to keep in step.
 */
export async function describeSeriesDownload(
  actor: Actor,
  seriesId: string,
): Promise<SeriesDownloadPayload> {
  const found = await findVisibleSeries(seriesId, actor.id, { includeUnpublished: false });
  if (found === null) {
    logger.warn('series.download.refused', {
      actorId: actor.id,
      action: 'series.browse',
      target: `series:${seriesId}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such series.');
  }

  const recordings: SeriesDownloadItem[] = [];
  for (const row of found.recordings) {
    // Published by construction — the series read applied the gate — so the second read is for the
    // key, which the series row deliberately does not carry.
    const recording = await findVisibleRecording(row.id, { includeUnpublished: false });
    if (recording === null) continue;
    const stored = await mediaStore().head(recording.playbackMediaKey ?? recording.originalMediaKey);
    if (stored === null) continue;
    recordings.push({
      id: row.id,
      title: row.title,
      recordedAt: row.recordedAt,
      bytes: stored.size,
    });
  }

  logger.info('series.download.described', {
    actorId: actor.id,
    action: 'series.browse',
    target: `series:${seriesId}`,
    count: recordings.length,
    bytes: recordings.reduce((sum, one) => sum + one.bytes, 0),
  });

  return { recordings };
}

/**
 * Flush an outbox and answer what to drop.
 *
 * Entries are applied **in the order sent**, oldest first, because that is the order the member
 * made them in: two positions on one teaching land newest-last and the newest stands. Each entry
 * is its own unit — one refusal does not stop the ones after it, and a refusal is a result rather
 * than an error, because the request as a whole did what it was asked.
 *
 * A receipt is read for every client id first and written after every apply, so an entry the
 * server has seen answers `duplicate` with nothing re-applied — and a note's receipt carries the
 * note it became, so the duplicate answer still hands the client the real row.
 */
export async function syncOutbox(actor: Actor, body: unknown): Promise<SyncPayload> {
  const request = parseSyncRequest(body);

  const receipts = new Map<string, SyncReceiptRow>();
  for (const receipt of await findSyncReceipts(
    actor.id,
    request.entries.map((entry) => entry.clientId),
  )) {
    receipts.set(receipt.clientId, receipt);
  }

  const results: SyncEntryResult[] = [];
  for (const entry of request.entries) {
    const seen = receipts.get(entry.clientId);
    if (seen !== undefined) {
      results.push(duplicateResult(seen));
      continue;
    }
    results.push(await applyEntry(actor, entry));
  }

  const revoked = await revokedAmong(request.downloaded);

  logger.info('sync.flushed', {
    actorId: actor.id,
    action: 'sync.flush',
    target: `user:${actor.id}`,
    entries: request.entries.length,
    applied: results.filter((one) => one.status === 'applied').length,
    refused: results.filter((one) => one.status === 'refused').length,
    duplicates: results.filter((one) => one.status === 'duplicate').length,
    downloaded: request.downloaded.length,
    revoked: revoked.length,
  });

  return { results, revoked, syncedAt: new Date().toISOString() };
}

async function applyEntry(actor: Actor, entry: SyncEntry): Promise<SyncEntryResult> {
  let note: NoteView | null = null;
  let refusal: Refusal | null = null;

  try {
    if (entry.kind === 'progress') {
      await writePlaybackProgress(actor, entry.recordingId, entry.body);
    } else {
      // The live route is behind `note.write`; the sync route is behind `recording.browse`, which
      // both roles hold, so the policy question the live route's access declaration asked is asked
      // here by hand before the service runs.
      if (!can(actor, 'note.write')) throw ApiError.forbidden();
      note = (await createNote(actor, entry.recordingId, entry.body)).note;
    }
  } catch (caught) {
    if (!(caught instanceof ApiError)) throw caught;
    refusal = { code: caught.code, message: caught.message };
  }

  await insertSyncReceipt({
    userId: actor.id,
    clientId: entry.clientId,
    kind: entry.kind,
    status: refusal === null ? 'applied' : 'refused',
    code: refusal?.code ?? null,
    message: refusal?.message ?? null,
    noteId: note?.id ?? null,
  });

  return {
    clientId: entry.clientId,
    status: refusal === null ? 'applied' : 'refused',
    code: refusal?.code ?? null,
    message: refusal?.message ?? null,
    note,
  };
}

/**
 * The answer for an entry seen before: `duplicate`, carrying the refusal if there was one and no
 * note. The receipt holds the note's id, not the row, and the row as it stands now — edited,
 * reacted to, or gone — is the notes list's to give: a client that reads `duplicate` drops its
 * pending copy and reads the teaching's notes again, which it does on every reconnect regardless.
 */
function duplicateResult(receipt: SyncReceiptRow): SyncEntryResult {
  return {
    clientId: receipt.clientId,
    status: 'duplicate',
    code: receipt.code,
    message: receipt.message,
    note: null,
  };
}

/**
 * Which of these ids this member may no longer hold. One visibility read for the whole list
 * rather than one per id — the condition lives in `listVisibleRecordings` and is not restated
 * here (tools/visibility-boundary.ts). An id that is not a recording at all is revoked too: there
 * is nothing it could be a download of.
 */
async function revokedAmong(downloaded: readonly string[]): Promise<string[]> {
  if (downloaded.length === 0) return [];
  const visible = new Set(
    (await listVisibleRecordings({ includeUnpublished: false })).map((row) => row.id),
  );
  return downloaded.filter((id) => !visible.has(id));
}

// =================================================================================================
// Parsing
// =================================================================================================

function parseSyncRequest(body: unknown): SyncRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with the outbox entries and the downloaded ids.');
  }
  const { entries, downloaded } = body as Partial<SyncRequest>;

  if (!Array.isArray(entries) || entries.length > MAX_SYNC_ENTRIES) {
    throw ApiError.invalidInput(`Send the outbox as a list of at most ${MAX_SYNC_ENTRIES} entries.`);
  }
  if (!Array.isArray(downloaded) || downloaded.length > MAX_SYNC_DOWNLOADED) {
    throw ApiError.invalidInput(
      `Send the downloaded ids as a list of at most ${MAX_SYNC_DOWNLOADED} ids.`,
    );
  }

  const seen = new Set<string>();
  const parsedEntries = entries.map((entry: unknown) => {
    const parsed = parseEntry(entry);
    if (seen.has(parsed.clientId)) {
      throw ApiError.invalidInput('Every outbox entry needs a client id of its own.');
    }
    seen.add(parsed.clientId);
    return parsed;
  });

  const parsedDownloaded = downloaded.map((id: unknown) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw ApiError.invalidInput('Give the downloaded recordings as a list of ids.');
    }
    return id;
  });

  return { entries: parsedEntries, downloaded: parsedDownloaded };
}

/**
 * The envelope only. The body of each entry is handed to the live service unparsed, so what a
 * malformed body is refused with is exactly what the live route would have said — and a client
 * that could not have sent it online cannot sneak it in through the outbox.
 */
function parseEntry(entry: unknown): SyncEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw ApiError.invalidInput('Each outbox entry is an object.');
  }
  const { clientId, kind, recordingId, at, body } = entry as Partial<SyncEntry>;
  if (!isClientId(clientId)) {
    throw ApiError.invalidInput('Each outbox entry carries a uuid client id.');
  }
  if (!isSyncEntryKind(kind)) {
    throw ApiError.invalidInput('Each outbox entry is a progress or a note entry.');
  }
  // The same uuid shape as the client id: a recording id that is not one would otherwise fail the
  // whole batch with a database error rather than refusing the one entry (security audit, 14).
  if (!isClientId(recordingId)) {
    throw ApiError.invalidInput('Each outbox entry names the recording it is about.');
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw ApiError.invalidInput('Each outbox entry says when it was written, as ISO 8601.');
  }
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Each outbox entry carries the body the live route would take.');
  }
  return kind === 'progress'
    ? { clientId, kind, recordingId, at, body: body as PlaybackProgressRequest }
    : { clientId, kind, recordingId, at, body: body as CreateNoteRequest };
}

function isSyncEntryKind(value: unknown): value is SyncEntryKind {
  return typeof value === 'string' && (SYNC_ENTRY_KINDS as readonly string[]).includes(value);
}
