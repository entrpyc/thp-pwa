'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { ACCEPTED_ARTWORK_LABEL, MAX_NOTE_IMAGES, MAX_NOTE_IMAGE_ALT_LENGTH, type NoteImageRef, type NoteImageView } from '@thp/shared';
import { offlineManager } from '@/client/offline/manager';
import {
  encodeNoteImage,
  forgetPendingImage,
  fromExisting,
  fromFile,
  imagesSettled,
  keepPendingImage,
  releasePreview,
  toImageRefs,
  uploadNoteImage,
  type AttachedImage,
} from '@/client/notes/images';
import styles from './notes.module.css';

/**
 * **The pictures a member is attaching** ([3.12.22](docs/project/prd.md), [3.12.25](docs/project/prd.md))
 * — the state behind the strip, shared by the composer, the reply field and the edit form.
 *
 * A chosen file is encoded at once and uploaded at once: by the time the member has written their
 * sentence the key is in hand and the save is one request, as it was before pictures. When the
 * grant cannot be asked for — the device is offline, or the server cannot be reached — the bytes
 * are kept on the device and the picture is **queued**: the save goes to the outbox with a pending
 * reference, and the flush uploads it later (`offline/pending-images.ts`). `settle()` is the save's
 * first step: it retries any queued upload while there is a connection, and keeps on the device
 * what still cannot go.
 */
export function useImageAttachments(initial: readonly NoteImageView[] = []) {
  const [images, setImages] = useState<AttachedImage[]>(() => fromExisting(initial));
  const latest = useRef(images);
  latest.current = images;

  const patch = useCallback((id: string, change: Partial<AttachedImage>) => {
    setImages((held) => held.map((one) => (one.id === id ? { ...one, ...change } : one)));
  }, []);

  /** Encode, then upload; on a failed grant keep the bytes and mark the picture queued. */
  const process = useCallback(
    async (image: AttachedImage, file: File) => {
      try {
        const encoded = await encodeNoteImage(file);
        releasePreview(image);
        const previewUrl = URL.createObjectURL(encoded.blob);
        patch(image.id, { previewUrl, blob: encoded.blob, contentType: encoded.contentType, status: 'uploading' });
        try {
          const key = await uploadNoteImage(encoded, file.name);
          patch(image.id, { key, status: 'uploaded' });
        } catch {
          patch(image.id, { status: 'queued' });
        }
      } catch {
        patch(image.id, { status: 'refused', complaint: `Could not read that picture. Upload ${ACCEPTED_ARTWORK_LABEL}.` });
      }
    },
    [patch],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      const room = MAX_NOTE_IMAGES - latest.current.length;
      const chosen = files.slice(0, Math.max(0, room));
      const rows = chosen.map((file) => [fromFile(file), file] as const);
      setImages((held) => [...held, ...rows.map(([image]) => image)]);
      for (const [image, file] of rows) {
        if (image.status === 'encoding') void process(image, file);
      }
    },
    [process],
  );

  const remove = useCallback((id: string) => {
    setImages((held) => {
      const gone = held.find((one) => one.id === id);
      if (gone !== undefined) {
        releasePreview(gone);
        if (gone.status === 'queued') void forgetPendingImage(gone.id);
      }
      return held.filter((one) => one.id !== id);
    });
  }, []);

  const setAlt = useCallback((id: string, alt: string) => patch(id, { alt: alt.slice(0, MAX_NOTE_IMAGE_ALT_LENGTH) }), [patch]);

  /**
   * Ready the pictures for a save: retry queued uploads, keep on the device what still cannot go,
   * and answer the references the body carries. Throws nothing; a refused picture is left out.
   */
  const settle = useCallback(async (): Promise<NoteImageRef[]> => {
    let current = latest.current;
    for (const image of current) {
      if (image.status !== 'queued' || image.blob === null || image.contentType === null) continue;
      try {
        const key = await uploadNoteImage({ blob: image.blob, contentType: image.contentType }, `${image.id}.webp`);
        patch(image.id, { key, status: 'uploaded' });
        current = current.map((one) => (one.id === image.id ? { ...one, key, status: 'uploaded' } : one));
        void forgetPendingImage(image.id);
      } catch {
        const userId = offlineManager().getSnapshot().userId;
        if (userId !== null) await keepPendingImage(image, userId).catch(() => undefined);
      }
    }
    return toImageRefs(current);
  }, [patch]);

  const reset = useCallback(() => {
    for (const one of latest.current) releasePreview(one);
    setImages([]);
  }, []);

  // Previews are object URLs; the strip going away releases the ones it still holds.
  useEffect(() => () => latest.current.forEach(releasePreview), []);

  return { images, add, remove, setAlt, settle, reset, settled: imagesSettled(images) };
}

export type ImageAttachments = ReturnType<typeof useImageAttachments>;

/**
 * **The strip itself**: an Add control, and for each picture a thumbnail, a description field and
 * Remove. What state a picture is in is said in words under it — "Uploading", "Will upload when
 * you are back online" — never by a spinner alone.
 */
export function ImageAttach({ attachments, disabled = false }: { attachments: ImageAttachments; disabled?: boolean }) {
  const inputId = useId();
  const { images, add, remove, setAlt } = attachments;
  const full = images.length >= MAX_NOTE_IMAGES;

  function onChosen(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    // Cleared at once, so choosing the same file again after a removal fires a change event.
    event.target.value = '';
    if (files.length > 0) add(files);
  }

  return (
    <div className={styles.attach}>
      {images.length === 0 ? null : (
        <ul className={styles.attachStrip} aria-label="Pictures on this note">
          {images.map((image, index) => (
            <li className={styles.attachTile} key={image.id}>
              {image.status === 'refused' ? (
                <p className={styles.attachRefused} role="alert">{image.complaint}</p>
              ) : (
                <img className={styles.attachThumb} src={image.previewUrl} alt={image.alt === '' ? `Picture ${index + 1}` : image.alt} />
              )}
              <input
                className={styles.attachAlt}
                type="text"
                aria-label={`Describe picture ${index + 1}`}
                placeholder="Describe it (optional)"
                maxLength={MAX_NOTE_IMAGE_ALT_LENGTH}
                value={image.alt}
                disabled={disabled || image.status === 'refused'}
                onChange={(event) => setAlt(image.id, event.target.value)}
              />
              <p className={styles.attachStatus}>{statusLine(image)}</p>
              <button
                className={styles.attachRemove}
                type="button"
                aria-label={`Remove picture ${index + 1}`}
                disabled={disabled}
                onClick={() => remove(image.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.attachAddRow}>
        <label className={full || disabled ? `${styles.attachAdd} ${styles.attachAddOff}` : styles.attachAdd} htmlFor={inputId}>
          {images.length === 0 ? 'Add a picture' : 'Add another picture'}
        </label>
        <input
          className={styles.attachInput}
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={full || disabled}
          onChange={onChosen}
        />
        <span className={styles.attachHint}>
          {full ? `${MAX_NOTE_IMAGES} is the most a note carries.` : `Up to ${MAX_NOTE_IMAGES}. ${ACCEPTED_ARTWORK_LABEL}.`}
        </span>
      </div>
    </div>
  );
}

function statusLine(image: AttachedImage): string {
  switch (image.status) {
    case 'encoding':
      return 'Preparing…';
    case 'uploading':
      return 'Uploading…';
    case 'uploaded':
      return 'Ready';
    case 'queued':
      return 'Will upload when you are back online';
    case 'existing':
      return 'On the note';
    case 'refused':
      return 'Not attached';
  }
}
