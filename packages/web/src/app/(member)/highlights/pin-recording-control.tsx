'use client';

import { recordingEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';
import styles from './highlights.module.css';

/**
 * **Pin a whole teaching** ([3.15.1](docs/project/prd.md)) — on the recording page's header and on
 * every row of a series page ([3.15.4](docs/project/prd.md)).
 *
 * One component for both placements, so the two cannot disagree about what pinned looks like or
 * says: `aria-pressed` carries the state, the label says what the press will do, and the text is
 * *Pin* or *Pinned*. The press toggles — pinned becomes unpinned — because a second filled press
 * is how every other toggle on the member surface works, and a pin is one press to undo so it
 * prompts for nothing (5.6.3).
 *
 * Disabled until the list has loaded, rather than drawn unpinned and then flipping: a control
 * that said *Pin* for a teaching already pinned would, for a moment, be offering to do the
 * opposite of what the press does.
 */
export function PinRecordingControl({
  recordingId,
  placement,
}: {
  recordingId: string;
  /** Where it sits, which decides only its spacing. */
  placement: 'header' | 'row';
}) {
  const { highlights, busy, toggle } = useHighlights();
  const existing = highlights === null ? null : recordingEntry(highlights, recordingId);
  const pinned = existing !== null;

  const control = (
    <button
      className={`${styles.pin}${placement === 'header' ? ` ${styles.headerPin}` : ''}`}
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? 'Unpin from Highlights' : 'Pin to Highlights'}
      disabled={highlights === null || busy}
      onClick={() => void toggle(existing, { kind: 'recording', recordingId })}
    >
      <span className={styles.icon} aria-hidden="true">
        {pinned ? '★' : '☆'}
      </span>
      {pinned ? 'Pinned' : 'Pin'}
    </button>
  );

  return placement === 'row' ? <div className={styles.rowPin}>{control}</div> : control;
}
