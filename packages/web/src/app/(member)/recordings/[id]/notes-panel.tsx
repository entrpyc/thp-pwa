'use client';

import { useEffect, useRef, useState } from 'react';
import {
  MAX_NOTE_LENGTH,
  NOTE_ALREADY_REMOVED_MESSAGE,
  NOTE_REMOVED_MESSAGE,
  NOTE_REMOVED_WHILE_REPLYING_MESSAGE,
  REACTIONS,
  formatTimecode,
  noteReactionPath,
  notePath,
  notePinPath,
  reactionName,
  recordingNotesPath,
  type NoteView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { usePlayer } from '../../player-context';
import { CharacterCount, NoteComposer } from './note-composer';
import styles from './notes.module.css';

/**
 * **The `Notes` tab of `pages/recording.png`** — the composer, the filter, the pinned group and the
 * list.
 *
 * Designed from `style-guide.md` rather than from a reference, because no reference draws below the
 * strip: the composer is the guide's raised inner panel, the filter is the guide's tab pill in the
 * treatment the recording strip already uses, and each note is the guide's standard card.
 *
 * Four things this component deliberately does **not** decide:
 *
 * - **Which notes exist.** The payload is what the reading member may see, and it was decided by the
 *   query (active-scope prd 3.1.9). The filter below narrows what is *listed* out of that set and
 *   never reaches a row the member was not already entitled to — which is why changing it changes
 *   nothing about the markers on the transport (3.2.3).
 * - **Where a note is anchored.** The frozen position is the player's (§5.1), so this panel and the
 *   transport's sheet (2.3) cannot disagree about which moment is being annotated.
 * - **What may be written.** Every rule the composer applies is applied again by the API
 *   independently (3.1.7, 3.1.8) — the standing rule the transcript panel's `canCorrect` follows.
 * - **Who may act.** `canModerate` decides whether an admin's entries are *drawn*; it grants
 *   nothing. A member who forged it would see controls the API refuses (3.7's standing rule).
 *
 * **Every write here refreshes the whole list rather than patching one card.** That is what makes a
 * note removed underneath the member show as a tombstone the moment they touch it (3.3.8, 3.4.10,
 * 3.5.7) — and it is the only refresh in this scope, because nothing polls and nothing is pushed.
 */

/** Which notes are listed. Component state, and deliberately not remembered across a reload. */
type Filter = 'all' | 'public' | 'mine';

const EMPTY_STATE: Record<Filter, string> = {
  all: 'No notes on this teaching yet. Write the first one.',
  public: 'Nobody has shared a note on this teaching yet.',
  mine: "You haven't written a note on this teaching yet.",
};

const FILTERS: readonly { readonly key: Filter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'public', label: 'Public' },
  { key: 'mine', label: 'Mine' },
];

/** How long a revealed note stays marked — long enough to find, short enough not to be a state. */
const HIGHLIGHT_MS = 2_000;

export function NotesPanel({
  recordingId,
  canModerate,
}: {
  recordingId: string;
  /** Whether to draw the admin entries in the overflow. It grants nothing — the API refuses. */
  canModerate: boolean;
}) {
  const player = usePlayer();
  const [filter, setFilter] = useState<Filter>('all');
  const [highlighted, setHighlighted] = useState<string | null>(null);

  /**
   * Opening the tab opens a composer **armed**, not frozen: the moment it shows follows the
   * teaching until the member types their first character
   * ([3.1.1](docs/active-scope/prd.md)). Closing the tab arms it again rather than leaving a moment
   * held, so a composer re-opened an hour later does not still be pointing at where it was shut.
   */
  const { releaseComposerAnchor } = player;
  useEffect(() => {
    releaseComposerAnchor();
    return () => releaseComposerAnchor();
  }, [releaseComposerAnchor]);

  /**
   * Take the member to the note a transport marker named ([3.2.5](docs/active-scope/prd.md)).
   *
   * The request is cleared as soon as it is acted on, so pressing the same marker twice scrolls
   * twice — a marker press is an instruction, not a selection that could go stale.
   */
  const { revealedNoteId, clearRevealedNote } = player;
  useEffect(() => {
    if (revealedNoteId === null) return;
    const target = document.getElementById(cardId(revealedNoteId));
    target?.scrollIntoView({ block: 'center' });
    setHighlighted(revealedNoteId);
    clearRevealedNote();
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [revealedNoteId, clearRevealedNote]);

  /**
   * Whatever the player is holding, rendered as-is.
   *
   * **No second check that these notes belong to this teaching.** The store is cleared when a
   * different recording is opened and the provider discards an answer that arrives late for the
   * previous one, so a set that does not belong here cannot reach this component — and a duplicate
   * guard here would hide a broken one there from every screen except the transport, which has no
   * panel to filter it.
   */
  const notes = player.notes?.notes ?? null;

  if (player.notesFailed) {
    return (
      <div className={styles.panel}>
        <p className={styles.failure}>Couldn&apos;t load notes.</p>
        <button className={styles.retry} type="button" onClick={() => player.refreshNotes()}>
          Try again
        </button>
      </div>
    );
  }

  const listed = notes === null ? null : notes.filter((one) => matches(one, filter));
  // Pinned notes read above the list and are **not repeated** at their position in it
  // ([3.6.5](docs/active-scope/prd.md)), so every note is read once. Both halves keep the payload's
  // own order, which is the list's total order and therefore also 3.6.5's.
  const pinned = listed === null ? [] : listed.filter((one) => one.pinned);
  const chronological = listed === null ? null : listed.filter((one) => !one.pinned);

  const shared = { canModerate, highlighted };

  return (
    <div className={styles.panel}>
      {/*
        Rendered from the first paint. An armed composer shows the position the player already
        holds — the restored resume position, or `00:00` (3.1.3) — so there is no instant at which
        it is showing a moment it does not mean.
      */}
      <NoteComposer recordingId={recordingId} />

      {/* The recording strip's own treatment, per 5.2.5 — the same control, one level down. */}
      <div className={styles.filters} role="tablist" aria-label="Which notes to show">
        {FILTERS.map((one) => (
          <button
            key={one.key}
            className={styles.filter}
            type="button"
            role="tab"
            aria-selected={filter === one.key}
            onClick={() => setFilter(one.key)}
          >
            {one.label}
          </button>
        ))}
      </div>

      {pinned.length === 0 ? null : (
        <section className={styles.pinnedGroup} aria-label="Pinned notes">
          {/* One heading over the group, so the raised notes visibly end (5.6.2). */}
          <h3 className={styles.pinnedHeading}>Pinned</h3>
          <ol className={styles.notes} aria-label="Pinned">
            {pinned.map((note) => (
              <NoteCard key={note.id} note={note} {...shared} />
            ))}
          </ol>
        </section>
      )}

      {/*
        Three states, and the third is why this is not two. A teaching whose only notes are pinned
        has nothing in its chronological list and is **not** empty — every note is read once, and
        it was read above. So the list renders when it has rows, the empty state renders when there
        is nothing anywhere, and neither renders in between.
      */}
      {chronological === null ? (
        <p className={styles.quiet}>Loading the notes…</p>
      ) : chronological.length > 0 ? (
        <ol className={styles.notes} aria-label="Notes">
          {chronological.map((note) => (
            <NoteCard key={note.id} note={note} {...shared} />
          ))}
        </ol>
      ) : pinned.length === 0 ? (
        <p className={styles.quiet}>{EMPTY_STATE[filter]}</p>
      ) : null}
    </div>
  );
}

/** The element a marker press scrolls to. */
function cardId(noteId: string): string {
  return `note-${noteId}`;
}

/**
 * Whether this note belongs in the current list.
 *
 * **A rendering decision over rows the reader already has**, not a privacy one — the payload never
 * carried anybody else's private note to begin with, and `Mine` is the reader's own notes of *both*
 * visibilities (3.2.3).
 */
function matches(note: NoteView, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'mine') return note.mine;
  return note.visibility === 'public';
}

interface CardProps {
  readonly note: NoteView;
  readonly canModerate: boolean;
  readonly highlighted: string | null;
}

/**
 * One note, as `style-guide.md`'s standard card ([5.2.1](docs/active-scope/prd.md)–5.2.4).
 *
 * The text is rendered as **the characters it is** ([3.1.6](docs/active-scope/prd.md)): React
 * escapes it, so markdown, HTML and a URL all read as themselves, and the stylesheet preserves the
 * line breaks rather than collapsing them.
 *
 * **A tombstone is this same card with almost everything taken away** — one dim italic line in place
 * of the author and the text, the timestamp and the thread kept, and no reaction row, no reply
 * control and nothing at all about who removed it ([5.3.3](docs/active-scope/prd.md)). The author of
 * an admin-removed note sees exactly this, like everyone else.
 */
function NoteCard({ note, canModerate, highlighted }: CardProps) {
  const player = usePlayer();
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const isReply = note.timestampMs === null;

  const className = [
    isReply ? styles.reply : styles.note,
    note.pinned ? styles.pinnedNote : '',
    highlighted === note.id ? styles.highlighted : '',
  ]
    .filter(Boolean)
    .join(' ');

  /**
   * **One card, two faces** — rather than an early return for the tombstone.
   *
   * A refused write is what forces it. The member presses **Reply** or **Save**, the API answers
   * `note_removed`, and the list refreshes to the tombstone in the same breath — so a tombstone
   * rendered by a separate return would unmount the very message and the very field the refusal is
   * supposed to leave standing ([5.3.4](docs/active-scope/prd.md),
   * [5.5.4](docs/active-scope/prd.md)). The refusal line and an already-open reply field therefore
   * live below the branch, where a note going away underneath the member cannot take them.
   *
   * What the tombstone does drop is every affordance: no author line, no text, no reactions, no
   * *new* reply control, no overflow, and nothing at all about who removed it — the author of an
   * admin-removed note sees exactly this, like everyone else.
   */
  return (
    <li className={className} id={cardId(note.id)}>
      {note.deleted ? (
        <>
          {note.timestampMs === null ? null : <TimeLink note={note} />}
          <p className={styles.tombstone}>This note was removed.</p>
        </>
      ) : (
        <>
          <div className={styles.noteHead}>
            {note.timestampMs === null ? null : <TimeLink note={note} />}
            {note.visibility === 'private' ? (
              <span className={styles.privatePill}>Private</span>
            ) : null}
            {note.pinned ? <span className={styles.pinnedPill}>Pinned</span> : null}
            <Overflow
              note={note}
              canModerate={canModerate}
              onEdit={() => setEditing(true)}
              onFailure={setFailure}
            />
          </div>

          <div className={styles.noteWho}>
            <span className={styles.monogram} aria-hidden="true">
              {monogram(note.authorDisplayName)}
            </span>
            <span className={styles.noteAuthor}>{note.authorDisplayName}</span>
            <span className={styles.noteWhen}>{writtenAt(note.createdAt)}</span>
          </div>

          {editing ? (
            <EditForm note={note} onDone={() => setEditing(false)} onFailure={setFailure} />
          ) : (
            <p className={styles.noteText}>{note.text}</p>
          )}

          <ReactionRow note={note} onFailure={setFailure} />
        </>
      )}

      {failure === null ? null : <p className={styles.cardFailure} role="status">
          {failure}
        </p>}

      {/*
        A field the member is already typing in outlives the note going away — that is what makes
        "the text is still there to be copied out" true. A private note and a reply never offer one
        (3.3.4, 3.3.5), and neither does a tombstone.
      */}
      {replying ? (
        <ReplyComposer
          note={note}
          recordingId={player.notes?.recordingId ?? ''}
          onDone={() => setReplying(false)}
        />
      ) : note.deleted || isReply || note.visibility === 'private' ? null : (
        <button className={styles.replyControl} type="button" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}

      <Thread note={note} canModerate={canModerate} highlighted={highlighted} />
    </li>
  );
}

/**
 * The thread under a note ([5.3.1](docs/active-scope/prd.md)).
 *
 * **A note with no replies renders nothing at all** — not an empty list
 * ([3.3.7](docs/active-scope/prd.md)) — which is why this returns `null` rather than an `<ol>` with
 * no children.
 */
function Thread({ note, canModerate, highlighted }: CardProps) {
  if (note.replies.length === 0) return null;
  return (
    <ol className={styles.thread} aria-label="Replies">
      {note.replies.map((reply) => (
        <NoteCard key={reply.id} note={reply} canModerate={canModerate} highlighted={highlighted} />
      ))}
    </ol>
  );
}

/**
 * The timestamp, pressable ([5.2.2](docs/active-scope/prd.md), 3.2.5).
 *
 * Seeks and does **not** start playback — the same rule selecting a transcript line already
 * follows, and for the same reason: a member finding their place has not asked for sound.
 */
function TimeLink({ note }: { note: NoteView }) {
  const player = usePlayer();
  const at = formatTimecode(note.timestampMs ?? 0);
  return (
    <button
      className={styles.noteTime}
      type="button"
      aria-label={`The note at ${at}`}
      onClick={() => player.seekToMs(note.timestampMs ?? 0)}
    >
      {at}
    </button>
  );
}

/**
 * The reaction row and the picker ([5.4.1](docs/active-scope/prd.md), 5.4.2).
 *
 * Every control carries the emoji's **name**, because a bare emoji is unreadable to a screen
 * reader — and a glyph that has left the vocabulary is labelled by itself rather than by nothing
 * ([3.4.2](docs/active-scope/prd.md)), which is what `reactionName` answers.
 */
function ReactionRow({
  note,
  onFailure,
}: {
  note: NoteView;
  onFailure: (message: string | null) => void;
}) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);

  // A private note takes no reactions, so it shows neither the row nor the control (3.4.8).
  if (note.visibility === 'private') return null;

  function choose(emoji: string): void {
    setOpen(false);
    onFailure(null);
    // Selecting what is already chosen clears it (3.4.4) — one gesture, two requests, and the
    // picker marks the current selection so the toggle is discoverable rather than a guess.
    const clearing = note.myReaction === emoji;
    const request = clearing
      ? { method: 'DELETE' as const, credentials: 'include' as const }
      : {
          method: 'PUT' as const,
          credentials: 'include' as const,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ emoji }),
        };
    void apiFetch(noteReactionPath(note.id), request)
      .catch((caught: unknown) => {
        onFailure(removedMessage(caught, NOTE_REMOVED_MESSAGE));
      })
      .finally(() => player.refreshNotes());
  }

  return (
    <div className={styles.reactions}>
      {note.reactions.map((one) => (
        <button
          key={one.emoji}
          className={one.emoji === note.myReaction ? styles.reactionMine : styles.reaction}
          type="button"
          aria-label={`${reactionName(one.emoji)}, ${one.count}`}
          onClick={() => choose(one.emoji)}
        >
          <span aria-hidden="true">{one.emoji}</span>
          <span aria-hidden="true">{one.count}</span>
        </button>
      ))}

      <button
        className={styles.pickerControl}
        type="button"
        aria-label="React to this note"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">+</span>
      </button>

      {open ? (
        <div className={styles.picker} role="group" aria-label="Choose a reaction">
          {REACTIONS.map((one) => (
            <button
              key={one.emoji}
              className={styles.pickerOption}
              type="button"
              aria-label={one.name}
              aria-pressed={one.emoji === note.myReaction}
              onClick={() => choose(one.emoji)}
            >
              <span aria-hidden="true">{one.emoji}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `···` overflow ([5.5.1](docs/active-scope/prd.md), [5.6.1](docs/active-scope/prd.md)).
 *
 * The author's own **Edit** and **Delete**; for an admin, **Delete** and **Pin** / **Unpin** on any
 * public note. A note that offers nothing draws no control at all rather than an empty menu.
 */
function Overflow({
  note,
  canModerate,
  onEdit,
  onFailure,
}: {
  note: NoteView;
  canModerate: boolean;
  onEdit: () => void;
  onFailure: (message: string | null) => void;
}) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Pinning is a top-level public note's alone (3.6.8) — a reply has no moment to raise, and a
  // private note is nobody else's to read.
  const canPin = canModerate && note.timestampMs !== null && note.visibility === 'public';
  const canDelete = note.mine || (canModerate && note.visibility === 'public');
  if (!note.mine && !canDelete && !canPin) return null;

  function act(path: string, method: 'DELETE' | 'PUT'): void {
    setOpen(false);
    setConfirming(false);
    onFailure(null);
    void apiFetch(path, { method, credentials: 'include' })
      .catch((caught: unknown) => onFailure(removedMessage(caught, NOTE_ALREADY_REMOVED_MESSAGE)))
      .finally(() => player.refreshNotes());
  }

  return (
    <div className={styles.overflow}>
      <button
        className={styles.overflowControl}
        type="button"
        aria-label="Note actions"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span aria-hidden="true">···</span>
      </button>

      {open ? (
        <div className={styles.menu} role="group" aria-label="Note actions">
          {note.mine ? (
            <button
              className={styles.menuItem}
              type="button"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              Edit
            </button>
          ) : null}
          {canDelete ? (
            <button className={styles.menuItem} type="button" onClick={() => setConfirming(true)}>
              Delete
            </button>
          ) : null}
          {canPin ? (
            /* Neither is destructive and both are one press to undo, so neither prompts (5.6.3). */
            <button
              className={styles.menuItem}
              type="button"
              onClick={() => act(notePinPath(note.id), note.pinned ? 'DELETE' : 'PUT')}
            >
              {note.pinned ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className={styles.confirm} role="group" aria-label="Confirm deletion">
          <p className={styles.confirmText}>{confirmationFor(note)}</p>
          <button
            className={styles.danger}
            type="button"
            onClick={() => act(notePath(note.id), 'DELETE')}
          >
            Delete
          </button>
          <button
            className={styles.secondary}
            type="button"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the confirmation says ([5.5.2](docs/active-scope/prd.md), 5.6.1).
 *
 * Three sentences, because three different things are about to be lost: a note on its own, a note
 * whose thread will outlive it, and somebody else's note whose removal goes on the record.
 */
function confirmationFor(note: NoteView): string {
  if (!note.mine) {
    return "Delete this member's note? This can't be undone, and the removal is logged.";
  }
  return note.replies.length > 0
    ? "Delete this note? The replies to it will stay. This can't be undone."
    : "Delete this note? This can't be undone.";
}

/**
 * The edit form ([5.5.3](docs/active-scope/prd.md)) — the card turned into the composer.
 *
 * The timestamp and the visibility are **shown and not editable**
 * ([3.5.3](docs/active-scope/prd.md)); they are rendered by the card above rather than repeated as
 * disabled controls here, which is the same thing said with less.
 */
function EditForm({
  note,
  onDone,
  onFailure,
}: {
  note: NoteView;
  onDone: () => void;
  onFailure: (message: string | null) => void;
}) {
  const player = usePlayer();
  const [text, setText] = useState(note.text);
  const [saving, setSaving] = useState(false);
  const count = text.trim().length;

  return (
    <form
      className={styles.editForm}
      aria-label="Edit this note"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        onFailure(null);
        void apiFetch(notePath(note.id), {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim() }),
        })
          .then(() => {
            onDone();
            player.refreshNotes();
          })
          .catch((caught: unknown) => {
            onFailure(removedMessage(caught, NOTE_ALREADY_REMOVED_MESSAGE));
            player.refreshNotes();
          })
          .finally(() => setSaving(false));
      }}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Your note</span>
        <textarea
          className={styles.textArea}
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      <CharacterCount count={count} />

      <div className={styles.composerActions}>
        <button
          className={styles.primary}
          type="submit"
          disabled={count === 0 || count > MAX_NOTE_LENGTH || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className={styles.secondary} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The inline reply field ([5.3.2](docs/active-scope/prd.md)).
 *
 * **No visibility control**, because a reply is always public ([3.3.3](docs/active-scope/prd.md)) —
 * there is nothing to choose, so there is nothing to render.
 *
 * **The text stays in the field when the note went away underneath it**
 * ([5.3.4](docs/active-scope/prd.md)): the member can copy out what they wrote before the list
 * refreshes under them, which is the whole reason that refusal has a message of its own.
 */
function ReplyComposer({
  note,
  recordingId,
  onDone,
}: {
  note: NoteView;
  recordingId: string;
  onDone: () => void;
}) {
  const player = usePlayer();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const count = text.trim().length;
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => field.current?.focus(), []);

  return (
    <form
      className={styles.replyForm}
      aria-label="Write a reply"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setFailure(null);
        void apiFetch(recordingNotesPath(recordingId), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim(), parentId: note.id }),
        })
          .then(() => {
            setText('');
            onDone();
            player.refreshNotes();
          })
          .catch((caught: unknown) => {
            setFailure(removedMessage(caught, NOTE_REMOVED_WHILE_REPLYING_MESSAGE));
            player.refreshNotes();
          })
          .finally(() => setSaving(false));
      }}
    >
      <textarea
        ref={field}
        className={styles.textArea}
        rows={2}
        placeholder="Write a reply"
        aria-label="Write a reply"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <CharacterCount count={count} />

      {failure === null ? null : <p className={styles.cardFailure} role="status">
          {failure}
        </p>}

      <div className={styles.composerActions}>
        <button
          className={styles.primary}
          type="submit"
          disabled={count === 0 || count > MAX_NOTE_LENGTH || saving}
        >
          {saving ? 'Saving…' : 'Reply'}
        </button>
        <button className={styles.secondary} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The sentence a refused write earns.
 *
 * `note_removed` is the one code this scope adds, and it exists so these three messages can differ:
 * the request was well-formed against an affordance that was real when it was rendered, so the
 * member is told the note went away rather than that they got something wrong. Anything else is a
 * failure the member can simply try again.
 */
function removedMessage(caught: unknown, whenRemoved: string): string {
  return caught instanceof ApiClientError && caught.code === 'note_removed'
    ? whenRemoved
    : 'That did not go through. Try again.';
}

/** Up to two initials, which is what 5.2.4's circle holds instead of a picture. */
function monogram(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const letters = [words[0], words[words.length - 1]]
    .filter((word, index, all) => word !== undefined && (index === 0 || word !== all[0]))
    .map((word) => (word as string).slice(0, 1));
  return letters.join('').toUpperCase() || '?';
}

const WRITTEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function writtenAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : WRITTEN.format(parsed);
}
