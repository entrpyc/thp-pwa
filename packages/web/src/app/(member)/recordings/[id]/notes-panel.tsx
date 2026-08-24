'use client';

import { useEffect, useState } from 'react';
import {
  MAX_NOTE_LENGTH,
  NOTE_RECORDING_GONE_MESSAGE,
  formatTimecode,
  recordingNotesPath,
  type CreateNotePayload,
  type NoteView,
  type NoteVisibility,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { usePlayer } from '../../player-context';
import styles from './notes.module.css';

/**
 * **The `Notes` tab of `pages/recording.png`** — the composer, the filter and the list.
 *
 * Designed from `style-guide.md` rather than from a reference, because no reference draws below the
 * strip: the composer is the guide's raised inner panel, the filter is the guide's tab pill in the
 * treatment the recording strip already uses, and each note is the guide's standard card.
 *
 * Three things this component deliberately does **not** decide:
 *
 * - **Which notes exist.** The payload is what the reading member may see, and it was decided by the
 *   query (active-scope prd 3.1.9). The filter below narrows what is *listed* out of that set and
 *   never reaches a row the member was not already entitled to — which is why changing it changes
 *   nothing about the markers on the transport (3.2.3).
 * - **Where the note is anchored.** The frozen position is the player's (§5.1), so this panel and
 *   the transport's sheet (Task 2.3) cannot disagree about which moment is being annotated.
 * - **What may be written.** Every rule the composer applies is applied again by the API
 *   independently (3.1.7, 3.1.8) — the standing rule the transcript panel's `canCorrect` follows.
 */

/** Which notes are listed. Component state, and deliberately not remembered across a reload. */
type Filter = 'all' | 'public' | 'mine';

/**
 * When the count appears ([3.1.7](docs/active-scope/prd.md)).
 *
 * Not a fraction of the ceiling: the requirement is a number of characters, and deriving it would
 * make changing the ceiling silently move where the warning starts.
 */
const COUNT_APPEARS_FROM = 900;

/** The ceiling as the copy spells it, so the message and the count read the same. */
const CEILING_LABEL = MAX_NOTE_LENGTH.toLocaleString('en-GB');

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

export function NotesPanel({ recordingId }: { recordingId: string }) {
  const player = usePlayer();
  const [filter, setFilter] = useState<Filter>('all');

  /**
   * Opening the tab **is** opening the composer, which is the instant the anchor freezes
   * ([3.1.1](docs/active-scope/prd.md)). Closing the tab lets it go, so the next opening anchors
   * where the member is by then rather than where they were.
   */
  const { openComposer, closeComposer } = player;
  useEffect(() => {
    openComposer();
    return () => closeComposer();
  }, [openComposer, closeComposer]);

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

  return (
    <div className={styles.panel}>
      {/*
        Rendered only once the anchor is frozen, which is one tick after this mounts. A composer
        painted before then would show `00:00` for that tick and then jump — and `00:00` is a real
        answer (3.1.3), so a member could not tell the flicker from the truth.
      */}
      {player.composerAnchorMs === null ? null : (
        <NoteComposer recordingId={recordingId} anchorMs={player.composerAnchorMs} />
      )}

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

      {listed === null ? (
        <p className={styles.quiet}>Loading the notes…</p>
      ) : listed.length === 0 ? (
        <p className={styles.quiet}>{EMPTY_STATE[filter]}</p>
      ) : (
        <ol className={styles.notes} aria-label="Notes">
          {listed.map((note) => (
            <NoteCard key={note.id} note={note} />
          ))}
        </ol>
      )}
    </div>
  );
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

/**
 * One note, as `style-guide.md`'s standard card ([5.2.1](docs/active-scope/prd.md)–5.2.4).
 *
 * The text is rendered as **the characters it is** ([3.1.6](docs/active-scope/prd.md)): React
 * escapes it, so markdown, HTML and a URL all read as themselves, and the stylesheet preserves the
 * line breaks rather than collapsing them.
 */
function NoteCard({ note }: { note: NoteView }) {
  const at = formatTimecode(note.timestampMs);
  return (
    <li className={styles.note}>
      <div className={styles.noteHead}>
        {/*
          Pressable, per 5.2.2. **What the press does is Task 2.2's** — seeking from a note and
          seeking from a marker are one behaviour and are built together, so this carries the
          affordance and no handler yet.
        */}
        <button className={styles.noteTime} type="button" aria-label={`The note at ${at}`}>
          {at}
        </button>
        {note.visibility === 'private' ? (
          <span className={styles.privatePill}>Private</span>
        ) : null}
      </div>

      <div className={styles.noteWho}>
        <span className={styles.monogram} aria-hidden="true">
          {monogram(note.authorDisplayName)}
        </span>
        <span className={styles.noteAuthor}>{note.authorDisplayName}</span>
        <span className={styles.noteWhen}>{writtenAt(note.createdAt)}</span>
      </div>

      <p className={styles.noteText}>{note.text}</p>
    </li>
  );
}

/**
 * The composer ([5.1.2](docs/active-scope/prd.md)–5.1.4).
 *
 * **The text survives a refusal.** Every failure path below leaves `text` exactly where it was, so a
 * teaching that went away underneath the member costs them a press rather than a paragraph
 * ([3.1.11](docs/active-scope/prd.md)).
 */
function NoteComposer({ recordingId, anchorMs }: { recordingId: string; anchorMs: number }) {
  const player = usePlayer();
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<NoteVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Counted after trimming, so padding cannot push a real note over the ceiling and a composer
  // holding nothing but spaces is a composer holding nothing (3.1.6, 3.1.8).
  const count = text.trim().length;
  const overLimit = count > MAX_NOTE_LENGTH;

  const { refreshNotes } = player;

  return (
    <form
      className={styles.composer}
      aria-label="Write a note"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setFailure(null);
        void apiFetch<CreateNotePayload>(recordingNotesPath(recordingId), {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim(), visibility, timestampMs: anchorMs }),
        })
          .then(() => {
            setText('');
            refreshNotes();
          })
          .catch((caught: unknown) => {
            setFailure(
              caught instanceof ApiClientError && caught.code === 'not_found'
                ? NOTE_RECORDING_GONE_MESSAGE
                : "Couldn't save your note. Your text is still here — try again.",
            );
          })
          .finally(() => setSaving(false));
      }}
    >
      {/* Frozen at the instant the composer opened, and not the author's to change (3.1.1). */}
      <p className={styles.anchor}>At {formatTimecode(anchorMs)}</p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Your note</span>
        <textarea
          className={styles.textArea}
          rows={4}
          placeholder="What landed at this moment?"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      {/*
        A labelled two-state control rather than a colour difference (5.1.3): whether the group will
        read this is the one thing about a note that cannot be undone, so it is spelled out in words
        and again in the line beneath.
      */}
      <div className={styles.visibility} role="group" aria-label="Who can see this note">
        <button
          className={styles.visibilityOption}
          type="button"
          aria-pressed={visibility === 'private'}
          onClick={() => setVisibility('private')}
        >
          Private
        </button>
        <button
          className={styles.visibilityOption}
          type="button"
          aria-pressed={visibility === 'public'}
          onClick={() => setVisibility('public')}
        >
          Public
        </button>
      </div>
      <p className={styles.visibilityHint}>
        {visibility === 'private'
          ? 'Only you will see this.'
          : 'Everyone in the group will see this at this moment.'}
      </p>

      {count >= COUNT_APPEARS_FROM ? (
        <p className={overLimit ? styles.countOver : styles.count}>
          {overLimit
            ? `${CEILING_LABEL} characters maximum.`
            : `${count.toLocaleString('en-GB')} / ${CEILING_LABEL}`}
        </p>
      ) : null}

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      <div className={styles.composerActions}>
        <button
          className={styles.primary}
          type="submit"
          disabled={count === 0 || overLimit || saving}
        >
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </form>
  );
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
