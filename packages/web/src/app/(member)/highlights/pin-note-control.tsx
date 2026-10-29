'use client';

import { track } from '@/client/observability/analytics';
import { noteEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';
import { MarkerIcon } from './marker-icon';

/**
 * **Highlight one of your own notes** ([3.12.17](docs/project/prd.md), [3.15.3](docs/project/prd.md))
 * — the marker beside the note's `···` control, drawn only on a top-level note the member wrote.
 * It lived in the actions menu until the operator moved it out: a highlight is one press, and a
 * press hidden behind a menu is two.
 *
 * It takes the panel's own control class, so it is the same round outline as the `···` beside it,
 * and `aria-pressed` carries the state the filled marker shows. The label says what the press
 * will do — *Add to Highlights* or *Remove from Highlights* — and never *Pin*, because the admin's
 * *Pin* in the menu is a different thing: it raises a public note above the list for everybody
 * ([3.12.15](docs/project/prd.md)). Neither direction prompts (5.6.3).
 */
export function PinNoteControl({
  noteId,
  recordingId,
  className,
}: {
  noteId: string;
  /** The teaching the note is on, for the analytics event; the note itself never travels. */
  recordingId: string;
  /** The panel's own round control class, so the marker draws as the `···` beside it. */
  className: string | undefined;
}) {
  const { highlights, busy, toggle } = useHighlights();
  const existing = highlights === null ? null : noteEntry(highlights, noteId);
  const pinned = existing !== null;

  return (
    <button
      className={className}
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? 'Remove from Highlights' : 'Add to Highlights'}
      disabled={highlights === null || busy}
      onClick={() => {
        track('highlight_acted', { action: pinned ? 'removed' : 'added', target: 'note', recording_id: recordingId });
        void toggle(existing, { kind: 'note', noteId });
      }}
    >
      <MarkerIcon marked={pinned} size={20} />
    </button>
  );
}
