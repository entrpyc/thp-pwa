'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  HIGHLIGHT_AT_PARAM,
  MY_NOTES_PATH,
  formatTimecode,
  monogramFor,
  reactionName,
  recordingPagePath,
  seriesPagePath,
  type MyNoteEntry,
  type MyNotesPayload,
  type NoteView,
  type NoteVisibility,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../player-context';
import { NoteImages } from '../recordings/[id]/note-images';
import { noteCardId, recordingTabHref } from '../recordings/[id]/round-trip';
import noteStyles from '../recordings/[id]/notes.module.css';
import styles from './my-notes.module.css';

/**
 * **My notes** — every note the member wrote, across every teaching, each inside the thread it
 * belongs to, newest written first.
 *
 * **Each card is the recording page's note card**, drawn from the same stylesheet, with one line
 * added above it: the teaching's title, a link to its page, and its series beside it. The
 * timestamp is the same green mark the recording page draws, and here it is a **link** rather
 * than a seek: it opens the teaching at that moment with the Notes tab open and the card scrolled
 * into view, which is where every control on a note — reply, edit, react, delete — already is.
 * Nothing is written from this page; it is the place to find a note, not to act on it.
 *
 * **Replies by other members are shown**, under the note, exactly as on the teaching — and a
 * note the member *replied to* is shown whole: the other member's note first, then every reply
 * including the member's own. Which cards are theirs is said by `mine`, which marks nothing here
 * but is what the filter reads.
 *
 * **Public / Private narrows what is listed** out of what the API answered — the recording
 * page's own rule. The payload never carried anybody else's private note to begin with.
 */

/** Which threads are listed. Component state, and deliberately not remembered across a reload. */
type Filter = 'all' | NoteVisibility;

const FILTERS: readonly { readonly key: Filter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'public', label: 'Public' },
  { key: 'private', label: 'Private' },
];

const EMPTY_STATE: Record<Filter, string> = {
  all: "You haven't written a note yet. Open a teaching and write one at the moment that matters.",
  public: "You haven't written a public note yet.",
  private: "You haven't written a private note yet.",
};

const LOAD_FAILED = "Couldn't load your notes.";

export function MyNotes() {
  useBreadcrumbTrail('My notes');
  const [entries, setEntries] = useState<readonly MyNoteEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    void apiFetch<MyNotesPayload>(MY_NOTES_PATH, { credentials: 'include' })
      .then((payload) => {
        if (!cancelled) setEntries(payload.entries);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setEntries(null);
        setFailure(caught instanceof ApiClientError ? caught.message : LOAD_FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const listed = entries === null ? null : entries.filter((one) => filter === 'all' || one.visibility === filter);

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>My notes</h1>
        <p className={styles.pageLead}>
          Every note you wrote, on every teaching. Press a timestamp to open the teaching there.
        </p>
      </header>

      {/* The recording page's own filter pill, one level up — the same control for the same choice. */}
      <div className={noteStyles.filters} role="tablist" aria-label="Which notes to show">
        {FILTERS.map((one) => (
          <button
            key={one.key}
            className={noteStyles.filter}
            type="button"
            role="tab"
            aria-selected={filter === one.key}
            onClick={() => setFilter(one.key)}
          >
            {one.label}
          </button>
        ))}
      </div>

      {failure !== null ? (
        <div className={styles.failed}>
          <p className={styles.failure}>{failure}</p>
          <button className={noteStyles.retry} type="button" onClick={() => setAttempt((was) => was + 1)}>
            Try again
          </button>
        </div>
      ) : listed === null ? (
        <p className={styles.quiet} role="status">
          Loading your notes…
        </p>
      ) : listed.length === 0 ? (
        <p className={styles.quiet} role="status">
          {EMPTY_STATE[filter]}
        </p>
      ) : (
        <ol className={styles.entries} aria-label="Your notes">
          {listed.map((entry) => (
            <Entry key={entry.note.id} entry={entry} />
          ))}
        </ol>
      )}
    </>
  );
}

/** One thread: the teaching it is on, then the note card with its replies under it. */
function Entry({ entry }: { entry: MyNoteEntry }) {
  const { recording, note } = entry;
  return (
    <li className={styles.entry}>
      <div className={styles.teaching}>
        <Link className={styles.teachingLink} href={recordingPagePath(recording.id)}>
          {recording.title}
        </Link>
        {recording.series === null ? null : (
          <Link className={styles.seriesLink} href={seriesPagePath(recording.series.id)}>
            {recording.series.title}
          </Link>
        )}
      </div>
      <NoteCard note={note} recordingId={recording.id} />
    </li>
  );
}

/**
 * The address of a note's moment: the teaching, opened at the note's timestamp with the Notes tab
 * showing and the card in view — the recording page reads all three off the address at mount.
 */
function momentHref(recordingId: string, note: NoteView): string {
  const at = note.timestampMs ?? 0;
  return `${recordingTabHref(recordingId, 'notes')}&${HIGHLIGHT_AT_PARAM}=${at}#${noteCardId(note.id)}`;
}

/**
 * One note as the recording page draws it — the same classes, minus every control: no overflow,
 * no reply field, no picker. The timestamp is a link to the moment rather than a seek, because
 * there is no player holding this teaching here.
 */
function NoteCard({ note, recordingId }: { note: NoteView; recordingId: string }) {
  const className = [noteStyles.note, note.pinned ? noteStyles.pinnedNote : ''].filter(Boolean).join(' ');
  return (
    <article className={className} id={noteCardId(note.id)} aria-label={note.mine ? 'Your note' : 'A note you replied to'}>
      {note.deleted ? (
        <>
          <TimeLink note={note} recordingId={recordingId} />
          <p className={noteStyles.tombstone}>This note was removed.</p>
        </>
      ) : (
        <>
          <div className={noteStyles.noteHead}>
            <TimeLink note={note} recordingId={recordingId} />
            {note.visibility === 'private' ? <span className={noteStyles.privatePill}>Private</span> : null}
            {note.pinned ? <span className={noteStyles.pinnedPill}>Pinned</span> : null}
          </div>
          <Body note={note} />
        </>
      )}

      {note.replies.length === 0 ? null : (
        <ol className={noteStyles.thread} aria-label="Replies">
          {note.replies.map((reply) => (
            <li key={reply.id} className={noteStyles.reply} id={noteCardId(reply.id)}>
              <Body note={reply} />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/** The author line, the text, the pictures and the reactions — what a note and a reply share. */
function Body({ note }: { note: NoteView }) {
  return (
    <>
      <div className={noteStyles.noteWho}>
        {note.authorAvatarUrl === null ? (
          <span className={noteStyles.monogram} aria-hidden="true">
            {monogramFor(note.authorDisplayName)}
          </span>
        ) : (
          <img className={noteStyles.avatar} src={note.authorAvatarUrl} alt="" />
        )}
        <span className={noteStyles.noteAuthor}>{note.authorDisplayName}</span>
        <span className={noteStyles.noteWhen}>{writtenAt(note.createdAt)}</span>
      </div>
      {note.text === '' ? null : <p className={noteStyles.noteText}>{note.text}</p>}
      <NoteImages images={note.images} />
      {/* The counts, as the teaching shows them; reacting is done there. A private note has none. */}
      {note.visibility === 'private' || note.reactions.length === 0 ? null : (
        <div className={noteStyles.reactions} aria-label="Reactions">
          {note.reactions.map((one) => (
            <span
              key={one.emoji}
              className={`${one.emoji === note.myReaction ? noteStyles.reactionMine : noteStyles.reaction} ${styles.reactionStatic}`}
              aria-label={`${reactionName(one.emoji)}, ${one.count}`}
            >
              <span aria-hidden="true">{one.emoji}</span>
              <span aria-hidden="true">{one.count}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** The timestamp, as a link to the moment on the teaching's page. */
function TimeLink({ note, recordingId }: { note: NoteView; recordingId: string }) {
  const at = formatTimecode(note.timestampMs ?? 0);
  return (
    <Link className={noteStyles.noteTime} href={momentHref(recordingId, note)} aria-label={`Open the teaching at ${at}`}>
      {at}
    </Link>
  );
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
