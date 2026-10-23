import type {
  CreateNoteRequest,
  NoteVisibility,
  PlaybackProgressRequest,
  SyncEntry,
  SyncEntryResult,
} from '@thp/shared';
import { BY_USER_INDEX, OFFLINE_STORES, type OutboxRecord } from './schema';
import { idbAllBy, idbDelete, idbPut } from './idb';

/**
 * **The outbox** ([3.18.14](docs/project/prd.md), [3.18.15](docs/project/prd.md); project tdd 5.3)
 * — writes made with no connection, kept until one returns.
 *
 * Two writers and one reader. The player appends a **position** when its progress write cannot
 * reach the server; the service worker's offline module appends a **note** when it answers the
 * composer's `POST` offline — the composer is not this ticket's to edit, and the worker is the one
 * place every request passes through regardless. Both write the same record to the same store,
 * which is why the shape and the key are in `schema.ts` and the worker carries a copy. The reader
 * is the manager's flush, which sends everything the member holds to `POST /sync` and applies the
 * answer with {@link applySyncResults}.
 *
 * **One position per recording, not a history.** tdd 5.3 says append-only, and for notes it is:
 * two notes are two entries. For positions the newest supersedes the one before it — a member
 * who listened for an hour offline has one place they got to, and sending six hundred positions
 * to establish it would be the outbox restating the cadence the player already applied. The
 * entry keeps the newest write's client id, so a flush that raced the replacement is still
 * recognised.
 */

/** Pending writes for one member, oldest first — the order the server applies them in. */
export async function listOutbox(userId: string): Promise<OutboxRecord[]> {
  const records = await idbAllBy<OutboxRecord>(OFFLINE_STORES.outbox, BY_USER_INDEX, userId);
  return records.sort((a, b) => a.at.localeCompare(b.at));
}

export async function countOutbox(userId: string): Promise<number> {
  return (await idbAllBy<OutboxRecord>(OFFLINE_STORES.outbox, BY_USER_INDEX, userId)).length;
}

/** A client id for a new entry. `crypto.randomUUID` exists everywhere a service worker does. */
export function mintClientId(): string {
  return crypto.randomUUID();
}

/**
 * Keep a position. Replaces any pending position for the same teaching — see the module comment
 * — and keeps the superseded entry's id nowhere: the server never saw it, so there is nothing to
 * recognise.
 */
export async function appendProgress(
  userId: string,
  recordingId: string,
  body: PlaybackProgressRequest,
): Promise<OutboxRecord> {
  const existing = (await listOutbox(userId)).filter(
    (one) => one.kind === 'progress' && one.recordingId === recordingId,
  );
  for (const old of existing) await idbDelete(OFFLINE_STORES.outbox, old.clientId);
  const record: OutboxRecord = {
    clientId: mintClientId(),
    userId,
    kind: 'progress',
    recordingId,
    at: new Date().toISOString(),
    body,
  };
  await idbPut(OFFLINE_STORES.outbox, record);
  return record;
}

export async function removeOutbox(clientIds: readonly string[]): Promise<void> {
  for (const clientId of clientIds) await idbDelete(OFFLINE_STORES.outbox, clientId);
}

/** The wire form of the outbox: the records, minus the account they are keyed under. */
export function toSyncEntries(records: readonly OutboxRecord[]): SyncEntry[] {
  return records.map((one) =>
    one.kind === 'progress'
      ? {
          clientId: one.clientId,
          kind: 'progress',
          recordingId: one.recordingId,
          at: one.at,
          body: one.body as PlaybackProgressRequest,
        }
      : {
          clientId: one.clientId,
          kind: 'note',
          recordingId: one.recordingId,
          at: one.at,
          body: one.body as CreateNoteRequest,
        },
  );
}

/** A note the server refused, going back to the member as a draft with the reason. */
export interface RefusedNote {
  readonly recordingId: string;
  readonly text: string;
  readonly visibility: NoteVisibility;
  readonly anchorMs: number;
  readonly message: string;
  /** Whether the teaching itself is gone, in which case there is nowhere to keep the draft. */
  readonly recordingGone: boolean;
}

export interface SyncOutcome {
  /** Entries the server has handled, whichever way, and the outbox no longer needs. */
  readonly settled: readonly string[];
  readonly refusedNotes: readonly RefusedNote[];
  /** Positions refused — dropped, as a dropped live write is; counted so the indicator can say so. */
  readonly droppedPositions: number;
  /** Teachings whose notes changed on the server, so the player can read them again. */
  readonly touchedRecordings: readonly string[];
}

/**
 * Read the server's answer against what was sent, as a value.
 *
 * Every entry the server answered — applied, refused or duplicate — is settled and leaves the
 * outbox: the server has a receipt and will say `duplicate` to any resend, so keeping it would
 * only cost a request. A refused note is the one answer the member has to see: its text goes
 * back as a draft (the operator's decision for this ticket) unless the teaching is gone, when
 * there is no draft to keep it under and the notice is all there is. An entry the server did not
 * answer — a truncated response — stays, and the next flush sends it again.
 */
export function applySyncResults(
  sent: readonly OutboxRecord[],
  results: readonly SyncEntryResult[],
): SyncOutcome {
  const byClientId = new Map(sent.map((one) => [one.clientId, one] as const));
  const settled: string[] = [];
  const refusedNotes: RefusedNote[] = [];
  const touched = new Set<string>();
  let droppedPositions = 0;

  for (const result of results) {
    const record = byClientId.get(result.clientId);
    if (record === undefined) continue;
    settled.push(result.clientId);

    if (record.kind === 'note') {
      touched.add(record.recordingId);
      if (result.status === 'refused') {
        const body = record.body as CreateNoteRequest;
        refusedNotes.push({
          recordingId: record.recordingId,
          text: body.text,
          visibility: body.visibility,
          anchorMs: body.timestampMs,
          message: result.message ?? 'The note could not be saved.',
          recordingGone: result.code === 'not_found',
        });
      }
    } else if (result.status === 'refused') {
      droppedPositions += 1;
    }
  }

  return { settled, refusedNotes, droppedPositions, touchedRecordings: [...touched] };
}
