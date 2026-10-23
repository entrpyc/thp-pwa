import { NOTE_IMAGE_UPLOADS_PATH, type CreateNoteRequest, type NoteImageRef, type UploadGrantPayload } from '@thp/shared';
import { idbDelete, idbGet, idbPut } from './idb';
import { OFFLINE_STORES, type OutboxRecord, type PendingImageRecord } from './schema';

/**
 * **Uploading the pictures of notes written offline, at the flush** ([3.12.22](docs/project/prd.md),
 * [3.18](docs/project/prd.md)).
 *
 * An outbox note may name pictures by pending id — bytes kept in IndexedDB because the device was
 * offline when they were chosen. The server refuses such a reference, so before the outbox leaves
 * the device each one is uploaded the way the composer would have: a grant, the bytes to the store,
 * and the key swapped into the entry. The swapped entry is written back to the outbox at once, so a
 * flush that fails after two of three uploads does not upload those two again.
 *
 * **An entry whose pictures cannot all be uploaded stays home this round.** The others go; the
 * next flush tries it again. A picture whose bytes are gone from the device (storage cleared) is
 * dropped from the note rather than holding the note hostage — the words still go, and the member
 * is told.
 */

export type JsonFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface PreparedOutbox {
  /** The entries ready to send, pictures by key. */
  readonly ready: OutboxRecord[];
  /** Entries held back because an upload failed. */
  readonly heldBack: number;
  /** Pictures whose bytes were no longer on the device and were dropped from their note. */
  readonly dropped: number;
  /** The pending ids the sent entries used, to forget once the server has answered. */
  readonly pendingIds: string[];
}

export async function prepareOutboxImages(
  records: readonly OutboxRecord[],
  fetchJson: JsonFetch,
  putBytes: (url: string, contentType: string, body: Blob) => Promise<boolean> = defaultPut,
): Promise<PreparedOutbox> {
  const ready: OutboxRecord[] = [];
  const pendingIds: string[] = [];
  let heldBack = 0;
  let dropped = 0;

  for (const record of records) {
    const body = record.body as CreateNoteRequest;
    const refs = record.kind === 'note' ? (body.images ?? []) : [];
    if (!refs.some((one) => 'pending' in one)) {
      ready.push(record);
      continue;
    }

    const next: NoteImageRef[] = [];
    let failed = false;
    for (const ref of refs) {
      if (!('pending' in ref)) {
        next.push(ref);
        continue;
      }
      pendingIds.push(ref.pending);
      const kept = await idbGet<PendingImageRecord>(OFFLINE_STORES.noteImages, ref.pending).catch(() => undefined);
      if (kept === undefined) {
        dropped += 1;
        continue;
      }
      try {
        const grant = await fetchJson<UploadGrantPayload>(NOTE_IMAGE_UPLOADS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: `${ref.pending}.webp`, contentType: kept.contentType, size: kept.blob.size }),
        });
        if (!(await putBytes(grant.url, grant.contentType, kept.blob))) throw new Error('the upload did not complete');
        next.push({ key: grant.key, alt: ref.alt ?? kept.alt ?? null });
      } catch {
        failed = true;
        break;
      }
    }

    if (failed) {
      // Keep what was uploaded so far, so the next flush starts from there.
      const partial: OutboxRecord = { ...record, body: { ...body, images: [...next, ...refs.slice(next.length + dropped)] } };
      await idbPut(OFFLINE_STORES.outbox, partial).catch(() => undefined);
      heldBack += 1;
      continue;
    }

    const words = body.text.trim() !== '';
    if (next.length === 0 && !words) {
      // Nothing left to send: the pictures are gone and there were no words. The entry is dropped
      // from the outbox rather than sent to be refused.
      await idbDelete(OFFLINE_STORES.outbox, record.clientId).catch(() => undefined);
      continue;
    }
    const { images: _gone, ...rest } = body;
    void _gone;
    const prepared: OutboxRecord = {
      ...record,
      body: next.length === 0 ? rest : { ...rest, images: next },
    };
    await idbPut(OFFLINE_STORES.outbox, prepared).catch(() => undefined);
    ready.push(prepared);
  }

  return { ready, heldBack, dropped, pendingIds };
}

/** Forget the device copies once the server has the note — or has refused it. */
export async function forgetPendingImages(ids: readonly string[]): Promise<void> {
  for (const id of ids) await idbDelete(OFFLINE_STORES.noteImages, id).catch(() => undefined);
}

async function defaultPut(url: string, contentType: string, body: Blob): Promise<boolean> {
  const sent = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
  return sent.ok;
}
