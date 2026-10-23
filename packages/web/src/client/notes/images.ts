import {
  NOTE_IMAGE_MAX_EDGE,
  NOTE_IMAGE_UPLOADS_PATH,
  type NoteImageRef,
  type NoteImageView,
  type UploadGrantPayload,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { checkChosenArtwork, encodeArtwork, type EncodedArtwork } from '@/client/artwork/encode';
import { idbDelete, idbPut } from '@/client/offline/idb';
import { OFFLINE_STORES, type PendingImageRecord } from '@/client/offline/schema';

/**
 * **A picture on its way onto a note** ([3.12.22](docs/project/prd.md)) — what the composer, the
 * reply field and the edit form each hold between the member choosing a file and the note being
 * written.
 *
 * Three states a picture can be in, and the note's body says which:
 *
 * - **uploaded** — the browser shrank it, asked for a grant and put the bytes in the store; the
 *   body names the `key`. This is every picture while the device is online.
 * - **queued** — the grant could not be asked for (the device is offline, or the server could not
 *   be reached). The bytes are kept in IndexedDB under a pending id, the body names `pending`, and
 *   the outbox flush uploads them when a connection is back (`offline/manager.ts`).
 * - **existing** — a picture the note already has, in the edit form; the body names its `id`.
 *
 * The preview is an object URL over the encoded bytes (or the signed URL for an existing one), so
 * what the member sees is what will be stored, not the twelve-megabyte original.
 */

export type AttachmentStatus = 'encoding' | 'uploading' | 'uploaded' | 'queued' | 'existing' | 'refused';

export interface AttachedImage {
  /** The client's own id for the row in the strip; also the pending id when queued. */
  readonly id: string;
  readonly previewUrl: string;
  readonly alt: string;
  readonly status: AttachmentStatus;
  /** The upload key once uploaded. */
  readonly key: string | null;
  /** The note's image id, for one the note already carries. */
  readonly existingId: string | null;
  /** The encoded bytes, kept so a queued picture can be stored and a failed upload retried. */
  readonly blob: Blob | null;
  readonly contentType: string | null;
  /** Why it was refused, when it was. */
  readonly complaint: string | null;
}

/** The rows the edit form starts from: what the note carries now. */
export function fromExisting(images: readonly NoteImageView[]): AttachedImage[] {
  return images.map((one) => ({
    id: one.id,
    previewUrl: one.url,
    alt: one.alt ?? '',
    status: 'existing',
    key: null,
    existingId: one.id,
    blob: null,
    contentType: null,
    complaint: null,
  }));
}

/** A chosen file before anything has been done to it. */
export function fromFile(file: File): AttachedImage {
  const complaint = checkChosenArtwork(file);
  return {
    id: crypto.randomUUID(),
    previewUrl: URL.createObjectURL(file),
    alt: '',
    status: complaint === null ? 'encoding' : 'refused',
    key: null,
    existingId: null,
    blob: null,
    contentType: null,
    complaint,
  };
}

/** Shrink to the note image edge and re-encode — the cover's encoder, one size smaller. */
export async function encodeNoteImage(file: File): Promise<EncodedArtwork> {
  return encodeArtwork(file, NOTE_IMAGE_MAX_EDGE);
}

/** Grant, then the bytes to the store — exactly as a cover's and an avatar's go. Answers the key. */
export async function uploadNoteImage(encoded: EncodedArtwork, filename: string): Promise<string> {
  const grant = await apiFetch<UploadGrantPayload>(NOTE_IMAGE_UPLOADS_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename, contentType: encoded.contentType, size: encoded.blob.size }),
  });
  const sent = await fetch(grant.url, {
    method: 'PUT',
    headers: { 'content-type': grant.contentType },
    body: encoded.blob,
  });
  if (!sent.ok) throw new Error('the upload did not complete');
  return grant.key;
}

/** Keep a queued picture's bytes on the device under its pending id, for the flush to find. */
export async function keepPendingImage(image: AttachedImage, userId: string): Promise<void> {
  if (image.blob === null || image.contentType === null) return;
  const record: PendingImageRecord = {
    id: image.id,
    userId,
    blob: image.blob,
    contentType: image.contentType,
    alt: image.alt.trim() === '' ? null : image.alt.trim(),
  };
  await idbPut(OFFLINE_STORES.noteImages, record);
}

export async function forgetPendingImage(id: string): Promise<void> {
  await idbDelete(OFFLINE_STORES.noteImages, id).catch(() => undefined);
}

/** What the body carries for these pictures, in strip order. A refused one is left out. */
export function toImageRefs(images: readonly AttachedImage[]): NoteImageRef[] {
  return images.flatMap((one): NoteImageRef[] => {
    const alt = one.alt.trim() === '' ? null : one.alt.trim();
    if (one.existingId !== null) return [{ id: one.existingId, alt }];
    if (one.key !== null) return [{ key: one.key, alt }];
    if (one.status === 'queued') return [{ pending: one.id, alt }];
    return [];
  });
}

/** Whether the strip is in a state a note can be written from: nothing still encoding or uploading. */
export function imagesSettled(images: readonly AttachedImage[]): boolean {
  return images.every((one) => one.status !== 'encoding' && one.status !== 'uploading');
}

export function releasePreview(image: AttachedImage): void {
  if (image.existingId === null && image.previewUrl.startsWith('blob:')) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
