'use client';

import { noteEntry } from './highlights-lookup';
import { useHighlights } from './highlights-store';

/**
 * **Pin one of your own notes** ([3.12.17](docs/project/prd.md), [3.15.3](docs/project/prd.md)) —
 * one item in the note actions menu, drawn only on a top-level note the member wrote.
 *
 * It takes the menu's own item class, so it reads as the entries beside it and the notes panel
 * mounts it in one line. The press closes the menu through `onDone` — the rule *Pin* and *Unpin*
 * (the admin's) already follow there — and toggles: a pinned note offers *Unpin from Highlights*,
 * because the menu is the one place a member reaches for a note and should also be where they can
 * take it back. Neither direction prompts (5.6.3).
 *
 * The admin's *Pin* is a different thing — it raises a public note above the list for everybody
 * ([3.12.15](docs/project/prd.md)) — and the two can sit in one menu; so the label here says where
 * the pin goes.
 */
export function PinNoteMenuItem({
  noteId,
  className,
  onDone,
}: {
  noteId: string;
  /** The menu's own item class, so the entry draws as the ones beside it. */
  className: string | undefined;
  onDone: () => void;
}) {
  const { highlights, busy, toggle } = useHighlights();
  const existing = highlights === null ? null : noteEntry(highlights, noteId);
  const pinned = existing !== null;

  return (
    <button
      className={className}
      type="button"
      disabled={highlights === null || busy}
      onClick={() => {
        onDone();
        void toggle(existing, { kind: 'note', noteId });
      }}
    >
      {pinned ? 'Unpin from Highlights' : 'Pin to Highlights'}
    </button>
  );
}
