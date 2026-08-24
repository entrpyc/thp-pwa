'use client';

import { useState } from 'react';
import {
  MAX_NOTE_LENGTH,
  NOTE_RECORDING_GONE_MESSAGE,
  formatTimecode,
  recordingNotesPath,
  type CreateNotePayload,
  type NoteVisibility,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { usePlayer } from '../../player-context';
import styles from './notes.module.css';

/**
 * **The composer** ([5.1.2](docs/active-scope/prd.md)–5.1.5), in its own module because it is
 * mounted twice from one implementation.
 *
 * Inline at the top of the notes panel, and as a **sheet over whatever screen the member is on**
 * from the transport's own menu ([3.1.2](docs/active-scope/prd.md)). Two mounts and one
 * implementation is the whole point: both read the frozen anchor from the player (§5.1), so the two
 * entry points cannot disagree about which moment is being annotated, and every text rule is
 * written once.
 *
 * **The text survives a refusal.** Every failure path below leaves `text` exactly where it was, so a
 * teaching that went away underneath the member costs them a press rather than a paragraph
 * ([3.1.11](docs/active-scope/prd.md)).
 *
 * Every rule this applies is applied again by the API independently (3.1.7, 3.1.8) — the standing
 * rule the transcript panel's `canCorrect` prop already follows.
 */

/**
 * When the count appears ([3.1.7](docs/active-scope/prd.md)).
 *
 * Not a fraction of the ceiling: the requirement is a number of characters, and deriving it would
 * make changing the ceiling silently move where the warning starts.
 */
export const COUNT_APPEARS_FROM = 900;

/** The ceiling as the copy spells it, so the message and the count read the same. */
export const CEILING_LABEL = MAX_NOTE_LENGTH.toLocaleString('en-GB');

/**
 * The count, on one rule for the composer, the reply field and the edit form
 * ([5.3.2](docs/active-scope/prd.md) says the reply's count is *the same rule as 5.1.4*, and the
 * only way to mean that is to render the same component).
 */
export function CharacterCount({ count }: { count: number }) {
  if (count < COUNT_APPEARS_FROM) return null;
  const over = count > MAX_NOTE_LENGTH;
  return (
    <p className={over ? styles.countOver : styles.count}>
      {over
        ? `${CEILING_LABEL} characters maximum.`
        : `${count.toLocaleString('en-GB')} / ${CEILING_LABEL}`}
    </p>
  );
}

/** What a member is told when a save fails for a reason that is not the teaching going away. */
export const SAVE_FAILED_MESSAGE = "Couldn't save your note. Your text is still here — try again.";

/** The refusal a member reads, chosen by the code the API answered with. */
export function refusalFor(caught: unknown, gone: string, fallback: string): string {
  return caught instanceof ApiClientError && caught.code === 'not_found' ? gone : fallback;
}

export function NoteComposer({
  recordingId,
  anchorMs,
  title,
  onSaved,
}: {
  recordingId: string;
  anchorMs: number;
  /**
   * The teaching's title, shown above the frozen timestamp — **only on the sheet**
   * ([5.1.5](docs/active-scope/prd.md)). Inline under the tab it would name the page the member is
   * already looking at; over another screen it is the only thing that says which teaching this note
   * is about.
   */
  title?: string;
  onSaved?: () => void;
}) {
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
            onSaved?.();
          })
          .catch((caught: unknown) => {
            setFailure(refusalFor(caught, NOTE_RECORDING_GONE_MESSAGE, SAVE_FAILED_MESSAGE));
          })
          .finally(() => setSaving(false));
      }}
    >
      {title === undefined ? null : <p className={styles.sheetTitle}>{title}</p>}

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

      <CharacterCount count={count} />

      {failure === null ? null : (
        <p className={styles.failure} role="status">
          {failure}
        </p>
      )}

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
