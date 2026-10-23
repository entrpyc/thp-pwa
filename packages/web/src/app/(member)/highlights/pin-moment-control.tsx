'use client';

import { momentEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';
import { MarkerIcon } from './marker-icon';
import styles from './highlights.module.css';

/**
 * **Pin one moment of a teaching** ([3.15.2](docs/project/prd.md)) — a given position, which the
 * chapter page uses for the chapter's start: on that page the thing a member is looking at *is*
 * a stretch of the teaching, so "pin this" means this stretch, from where it begins. The server
 * snaps the position to the line playing there, exactly as the transport's tool does for the
 * moment being heard, so a chapter pinned here and the same opening line pinned from the transport
 * are one entry.
 *
 * `label` names the thing for the accessible name — *Highlight this chapter* — because *Highlight
 * this moment* on a page that shows no moment would be a label about the mechanism rather than
 * the thing.
 */
export function PinMomentControl({
  recordingId,
  positionMs,
  label,
}: {
  recordingId: string;
  positionMs: number;
  /** The noun: `this chapter`. Prefixed with *Highlight* or *Remove highlight from*. */
  label: string;
}) {
  const { highlights, busy, toggle } = useHighlights();
  const existing = highlights === null ? null : momentEntry(highlights, recordingId, positionMs);
  const pinned = existing !== null;

  return (
    <button
      className={`${styles.pin} ${styles.headerPin}`}
      type="button"
      aria-pressed={pinned}
      aria-label={`${pinned ? 'Remove highlight from' : 'Highlight'} ${label}`}
      disabled={highlights === null || busy}
      onClick={() => void toggle(existing, { kind: 'segment', recordingId, positionMs })}
    >
      <MarkerIcon marked={pinned} size={20} />
    </button>
  );
}
