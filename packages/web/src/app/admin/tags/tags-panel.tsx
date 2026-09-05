'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  MAX_TAG_LENGTH,
  TAGS_PATH,
  normaliseTagName,
  tagPath,
  type DeleteTagPayload,
  type TagListPayload,
  type TagView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './tags.module.css';

/**
 * The create form and the list of every tag ([4.7](docs/project/prd.md)).
 *
 * A client module: it imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes.
 *
 * Three things this screen is careful about:
 *
 * 1. **A tag on nothing is shown, not hidden.** This is where a tag is created ahead of the
 *    teaching it is for, and a list that hid it would make that pointless. Its counts read
 *    `0 recordings · 0 series`, which is the honest rendering of a tag nobody has used yet.
 * 2. **Renaming is an inline field, not a separate screen.** A tag is a name and nothing else, so
 *    editing one is one input and a press — and the press renames it on every recording and every
 *    series at once, which is the whole reason a tag is a row rather than a word on each item.
 * 3. **Deleting takes a confirming press, and the confirmation says what it costs.** The counts on
 *    the row are exactly the number of things the tag comes off, so the sentence is built from them
 *    rather than from a general warning; what comes back from the API is what was actually removed.
 */

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

/** `3 recordings · 1 series`. Both counts always, so a tag on nothing reads as on nothing twice. */
export function describeTagUse(tag: TagView): string {
  const recordings = `${tag.recordingCount} ${tag.recordingCount === 1 ? 'recording' : 'recordings'}`;
  return `${recordings} · ${tag.seriesCount} series`;
}

export function TagsPanel() {
  const nameId = useId();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [tags, setTags] = useState<readonly TagView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<TagListPayload>(TAGS_PATH, { credentials: 'include' });
      // Rendered in the order the API sent — alphabetical — and never re-sorted here.
      setTags(payload.tags);
      setListError(null);
    } catch (caught) {
      setTags(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      await apiFetch(TAGS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setDone(`“${normaliseTagName(name)}” is created.`);
      setName('');
      await loadTags();
    } catch (caught) {
      // Refused: what was typed stays exactly where it is, so being refused costs the press alone.
      setFailure(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="create-tag-heading">
        <div>
          <h2 className={styles.sectionTitle} id="create-tag-heading">
            Create a tag
          </h2>
          <p className={styles.sectionNote}>
            One word or two, lowercase. Tags are put on recordings and series from their own rows,
            where you can also type a new one straight in — this is for naming one ahead of time.
          </p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={nameId}>
              Name
            </label>
            <input
              className={styles.input}
              id={nameId}
              name="name"
              type="text"
              autoComplete="off"
              maxLength={MAX_TAG_LENGTH}
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <button className={styles.submit} type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create tag'}
          </button>

          {failure === null ? null : (
            <p className={styles.failure} role="alert">
              {failure}
            </p>
          )}
          {done === null ? null : (
            <p className={styles.done} role="status">
              {done}
            </p>
          )}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="tags-heading">
        <div>
          <h2 className={styles.sectionTitle} id="tags-heading">
            Tags
          </h2>
          <p className={styles.sectionNote}>
            Every tag, alphabetically, with how many recordings and series carry it. The counts
            include unpublished recordings — a member sees a tag only on what they can open.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : tags === null ? (
          <p className={styles.sectionNote}>Loading tags…</p>
        ) : tags.length === 0 ? (
          <p className={styles.empty}>No tags yet. Create one above and it will appear here.</p>
        ) : (
          <ul className={styles.list}>
            {tags.map((entry) => (
              <TagRow key={entry.id} entry={entry} onChanged={loadTags} onDone={setDone} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One tag, its counts, the inline field that renames it, and the confirming press that deletes it. */
function TagRow({
  entry,
  onChanged,
  onDone,
}: {
  entry: TagView;
  onChanged: () => Promise<void>;
  /** Where a deletion reports what it did — the row itself is gone by the time it could say so. */
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'rename' | 'delete' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [name, setName] = useState(entry.name);

  async function rename(): Promise<void> {
    if (busy !== null) return;
    setBusy('rename');
    setNote(null);
    try {
      await apiFetch(tagPath(entry.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      setEditing(false);
      await onChanged();
    } catch (caught) {
      setNote(describeFailure(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    if (busy !== null) return;
    setBusy('delete');
    setNote(null);
    try {
      const removed = await apiFetch<DeleteTagPayload>(tagPath(entry.id), {
        method: 'DELETE',
        credentials: 'include',
      });
      setConfirming(false);
      onDone(
        `“${removed.name}” is deleted. It came off ${plural(removed.recordingCount, 'recording')} and ${removed.seriesCount} series.`,
      );
      await onChanged();
    } catch (caught) {
      setNote(describeFailure(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={styles.listRow}>
      <div className={styles.rowIdentity}>
        <p className={styles.rowName}>{entry.name}</p>
        <p className={styles.rowMeta}>{describeTagUse(entry)}</p>
      </div>

      <div className={styles.rowControls}>
        <button
          className={styles.action}
          type="button"
          disabled={busy !== null}
          onClick={() => {
            // Seeded from the row at the moment of opening, so a reload mid-typing cannot
            // overwrite what is in the field.
            setName(entry.name);
            setConfirming(false);
            setEditing(!editing);
          }}
        >
          {editing ? 'Cancel rename' : 'Rename'}
        </button>
        <button
          className={styles.action}
          type="button"
          disabled={busy !== null}
          onClick={() => {
            setEditing(false);
            setConfirming(true);
          }}
        >
          Delete
        </button>
      </div>

      {editing ? (
        <div className={styles.editor}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`tag-name-${entry.id}`}>
              Name
            </label>
            <input
              className={styles.input}
              id={`tag-name-${entry.id}`}
              name="name"
              type="text"
              autoComplete="off"
              maxLength={MAX_TAG_LENGTH}
              disabled={busy !== null}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button
            className={styles.submit}
            type="button"
            disabled={busy !== null}
            onClick={() => void rename()}
          >
            {busy === 'rename' ? 'Saving…' : 'Save name'}
          </button>
        </div>
      ) : null}

      {/*
        The confirming press, because deleting reaches every teaching and study the tag is on. It
        says exactly how many, and what is *not* touched — which is the fact an admin hesitating over
        this button actually needs.
      */}
      {confirming ? (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            Delete “{entry.name}”? It comes off {describeTagUse(entry)}. The recordings and series
            themselves are not changed.
          </p>
          <div className={styles.confirmActions}>
            <button
              className={styles.actionStrong}
              type="button"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              {busy === 'delete' ? 'Deleting…' : 'Yes, delete it'}
            </button>
            <button className={styles.action} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {note === null ? null : (
        <p className={styles.rowRefusal} role="alert">
          {note}
        </p>
      )}
    </li>
  );
}
