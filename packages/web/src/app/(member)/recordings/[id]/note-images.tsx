'use client';

import { useEffect, useState } from 'react';
import { imageFallbackAlt, type NoteImageView } from '@thp/shared';
import { track } from '@/client/observability/analytics';
import styles from './notes.module.css';

/**
 * **The pictures on a note, as a reader sees them** ([3.12.22](docs/project/prd.md)): a strip of
 * square thumbnails under the text, and a press on one opens it full size in an overlay with the
 * way to the next and the previous, the author's description as a caption, and Remove where the
 * reader may ([3.12.24](docs/project/prd.md)).
 *
 * The overlay is a dialog in the accessibility tree and closes on Escape; the arrow keys move
 * between pictures. A picture with no description is announced as "Image 2 of 3", never as nothing.
 */
export function NoteImages({
  images,
  recordingId,
  onRemove,
}: {
  images: readonly NoteImageView[];
  /** The teaching the note is on, which is all analytics learns when a picture is opened. */
  recordingId: string;
  /** When given, a Remove control is offered on each picture in the overlay. */
  onRemove?: (imageId: string) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (open === null) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(null);
      if (event.key === 'ArrowRight') setOpen((held) => (held === null ? null : Math.min(images.length - 1, held + 1)));
      if (event.key === 'ArrowLeft') setOpen((held) => (held === null ? null : Math.max(0, held - 1)));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, images.length]);

  if (images.length === 0) return null;
  const shown = open === null ? null : images[open];

  return (
    <>
      <ul className={styles.imageStrip} aria-label="Pictures">
        {images.map((image, index) => (
          <li key={image.id}>
            <button
              className={styles.imageThumbButton}
              type="button"
              aria-label={`Open ${image.alt ?? imageFallbackAlt(index, images.length)}`}
              onClick={() => {
                track('note_interacted', { action: 'image_viewed', recording_id: recordingId });
                setOpen(index);
              }}
            >
              <img className={styles.imageThumb} src={image.url} alt={image.alt ?? imageFallbackAlt(index, images.length)} loading="lazy" />
            </button>
          </li>
        ))}
      </ul>

      {shown === undefined || shown === null || open === null ? null : (
        <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={shown.alt ?? imageFallbackAlt(open, images.length)}>
          <div className={styles.lightboxBar}>
            <span className={styles.lightboxCount}>
              {images.length === 1 ? '' : `${open + 1} / ${images.length}`}
            </span>
            {onRemove === undefined ? null : (
              <button
                className={styles.lightboxAction}
                type="button"
                onClick={() => {
                  const target = shown.id;
                  setOpen(null);
                  onRemove(target);
                }}
              >
                Remove picture
              </button>
            )}
            <button className={styles.lightboxAction} type="button" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <div className={styles.lightboxStage}>
            {open > 0 ? (
              <button className={styles.lightboxNav} type="button" aria-label="Previous picture" onClick={() => setOpen(open - 1)}>
                ‹
              </button>
            ) : <span className={styles.lightboxNavSpace} />}
            <img className={styles.lightboxImage} src={shown.url} alt={shown.alt ?? imageFallbackAlt(open, images.length)} />
            {open < images.length - 1 ? (
              <button className={styles.lightboxNav} type="button" aria-label="Next picture" onClick={() => setOpen(open + 1)}>
                ›
              </button>
            ) : <span className={styles.lightboxNavSpace} />}
          </div>
          {shown.alt === null ? null : <p className={styles.lightboxCaption}>{shown.alt}</p>}
        </div>
      )}
    </>
  );
}
