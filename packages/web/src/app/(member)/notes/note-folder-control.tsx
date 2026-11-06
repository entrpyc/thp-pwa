'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  MAX_NOTE_FOLDERS,
  MAX_NOTE_FOLDER_NAME_LENGTH,
  foldersOfNote,
  normaliseNoteFolderName,
  type NoteFolderView,
} from '@thp/shared';
import { FolderIcon } from './folder-icon';
import { folderFailureMessage, useNoteFolders } from './note-folders-store';
import styles from './note-folders.module.css';

/**
 * **File one of your own notes** — the folder beside the highlighter on a top-level note the
 * member wrote, on the recording page and on *My notes* alike. One press opens the picker; the
 * icon fills while the note is in at least one folder, and the label says how many.
 *
 * It takes the panel's own control class, so it is the same round outline as the marker and the
 * `···` beside it. Disabled until the folders have loaded, for the reason the marker is: a picker
 * that opened over an unknown list would have to guess what is ticked.
 */
export function NoteFolderControl({ noteId, className }: { noteId: string; className: string | undefined }) {
  const { folders } = useNoteFolders();
  const [open, setOpen] = useState(false);
  const filed = folders === null ? [] : foldersOfNote(folders, noteId);

  return (
    <>
      <button
        className={className}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          filed.length === 0
            ? 'Add to a folder'
            : `In ${filed.length} ${filed.length === 1 ? 'folder' : 'folders'} — change folders`
        }
        data-filed={filed.length > 0 ? 'true' : 'false'}
        disabled={folders === null}
        onClick={() => setOpen(true)}
      >
        <FolderIcon filed={filed.length > 0} size={20} />
      </button>
      {open && folders !== null ? (
        <NoteFolderPicker noteId={noteId} folders={folders} onDone={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * **The picker**: every folder as a checkbox, ticked where the note already is; a field to make
 * a new folder, which is ticked the moment it exists; **Save** writes the whole set in one request
 * and **Cancel** writes nothing. A modal, because it is the one place on a note card where a
 * member makes several choices before committing — a menu that closed on each tick would be a
 * request per tick and a card that changed under the hand.
 *
 * Escape and the backdrop cancel. Focus lands on the first checkbox, or on the name field when
 * there is nothing to tick yet.
 */
function NoteFolderPicker({
  noteId,
  folders,
  onDone,
}: {
  noteId: string;
  folders: readonly NoteFolderView[];
  onDone: () => void;
}) {
  const { busy, create, setFolders } = useNoteFolders();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(foldersOfNote(folders, noteId).map((one) => one.id)),
  );
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const nameId = useId();
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onDone();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDone]);

  const full = folders.length >= MAX_NOTE_FOLDERS;
  const typed = normaliseNoteFolderName(name);

  function toggle(folderId: string): void {
    setChosen((was) => {
      const next = new Set(was);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function makeFolder(): void {
    if (typed === null || full) return;
    setFailure(null);
    void create(typed)
      .then((made) => {
        setName('');
        if (made !== null) setChosen((was) => new Set([...was, made.id]));
      })
      .catch((caught: unknown) => setFailure(folderFailureMessage(caught)));
  }

  function save(): void {
    setFailure(null);
    void setFolders(noteId, [...chosen])
      .then(onDone)
      .catch((caught: unknown) => setFailure(folderFailureMessage(caught)));
  }

  return (
    <div className={styles.backdrop} onPointerDown={(event) => event.target === event.currentTarget && onDone()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 className={styles.title} id={titleId}>
          Folders for this note
        </h2>

        {folders.length === 0 ? (
          <p className={styles.quiet}>You have no folders yet. Make one below and this note goes in it.</p>
        ) : (
          <ul className={styles.options} aria-label="Your folders">
            {folders.map((one, index) => (
              <li key={one.id}>
                <label className={styles.option}>
                  <input
                    ref={index === 0 ? first : undefined}
                    className={styles.box}
                    type="checkbox"
                    checked={chosen.has(one.id)}
                    onChange={() => toggle(one.id)}
                  />
                  <span className={styles.optionName}>{one.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.newFolder}>
          <label className={styles.fieldLabel} htmlFor={nameId}>
            New folder
          </label>
          <div className={styles.newFolderRow}>
            <input
              ref={folders.length === 0 ? first : undefined}
              className={styles.input}
              id={nameId}
              type="text"
              value={name}
              maxLength={MAX_NOTE_FOLDER_NAME_LENGTH}
              placeholder={full ? `You have ${MAX_NOTE_FOLDERS} folders already` : 'Folder name'}
              disabled={full || busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  makeFolder();
                }
              }}
            />
            <button
              className={styles.secondary}
              type="button"
              disabled={typed === null || full || busy}
              onClick={makeFolder}
            >
              Create
            </button>
          </div>
          <p className={styles.count}>
            {folders.length} of {MAX_NOTE_FOLDERS} folders
          </p>
        </div>

        {failure === null ? null : (
          <p className={styles.failure} role="alert">
            {failure}
          </p>
        )}

        <div className={styles.actions}>
          <button className={styles.primary} type="button" disabled={busy} onClick={save}>
            Save
          </button>
          <button className={styles.secondary} type="button" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
