'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  MAX_NOTE_FOLDERS,
  MAX_NOTE_FOLDER_NAME_LENGTH,
  normaliseNoteFolderName,
  type NoteFolderView,
} from '@thp/shared';
import { folderFailureMessage, useNoteFolders } from './note-folders-store';
import styles from './note-folders.module.css';

/**
 * **Manage folders** — reached from the folder row on *My notes*: every folder with how many
 * notes it holds, **Rename** and **Delete** on each, and a field to make a new one. Deleting a
 * folder never deletes a note: the sentence under the confirmation says so, because that is the
 * one thing a member about to press it wants to know.
 *
 * One folder is edited at a time — a rename field or a delete confirmation, never both — so the
 * list stays legible with a hundred rows. Escape and the backdrop close it; nothing is lost,
 * because every change was already saved when its own control was pressed.
 */
export function ManageFoldersDialog({
  folders,
  onDone,
}: {
  folders: readonly NoteFolderView[];
  onDone: () => void;
}) {
  const { busy, create, rename, remove } = useNoteFolders();
  const [editing, setEditing] = useState<{ id: string; mode: 'rename' | 'delete' } | null>(null);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const nameId = useId();
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
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

  function act(work: Promise<unknown>): void {
    setFailure(null);
    void work
      .then(() => setEditing(null))
      .catch((caught: unknown) => setFailure(folderFailureMessage(caught)));
  }

  function makeFolder(): void {
    if (typed === null || full) return;
    setFailure(null);
    void create(typed)
      .then(() => setName(''))
      .catch((caught: unknown) => setFailure(folderFailureMessage(caught)));
  }

  return (
    <div className={styles.backdrop} onPointerDown={(event) => event.target === event.currentTarget && onDone()}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.titleRow}>
          <h2 className={styles.title} id={titleId}>
            Manage folders
          </h2>
          <button ref={close} className={styles.secondary} type="button" onClick={onDone}>
            Close
          </button>
        </div>

        {folders.length === 0 ? (
          <p className={styles.quiet}>You have no folders yet.</p>
        ) : (
          <ul className={styles.rows} aria-label="Your folders">
            {folders.map((one) => (
              <li key={one.id} className={styles.row}>
                {editing?.id === one.id && editing.mode === 'rename' ? (
                  <RenameRow
                    folder={one}
                    busy={busy}
                    onSave={(next) => act(rename(one.id, next))}
                    onCancel={() => setEditing(null)}
                  />
                ) : editing?.id === one.id && editing.mode === 'delete' ? (
                  <div className={styles.confirm} role="group" aria-label={`Confirm deleting ${one.name}`}>
                    <p className={styles.confirmText}>
                      Delete “{one.name}”? {countOf(one)} stay in your notes, just not in this folder.
                    </p>
                    <button className={styles.danger} type="button" disabled={busy} onClick={() => act(remove(one.id))}>
                      Delete
                    </button>
                    <button className={styles.secondary} type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <span className={styles.rowName}>{one.name}</span>
                    <span className={styles.rowCount}>{countOf(one)}</span>
                    <button
                      className={styles.rowAction}
                      type="button"
                      onClick={() => {
                        setFailure(null);
                        setEditing({ id: one.id, mode: 'rename' });
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className={styles.rowAction}
                      type="button"
                      onClick={() => {
                        setFailure(null);
                        setEditing({ id: one.id, mode: 'delete' });
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
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
      </div>
    </div>
  );
}

function RenameRow({
  folder,
  busy,
  onSave,
  onCancel,
}: {
  folder: NoteFolderView;
  busy: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(folder.name);
  const field = useRef<HTMLInputElement>(null);
  const typed = normaliseNoteFolderName(draft);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  function save(): void {
    if (typed === null) return;
    if (typed === folder.name) {
      onCancel();
      return;
    }
    onSave(typed);
  }

  return (
    <div className={styles.renameRow} role="group" aria-label={`Rename ${folder.name}`}>
      <input
        ref={field}
        className={styles.input}
        type="text"
        value={draft}
        maxLength={MAX_NOTE_FOLDER_NAME_LENGTH}
        aria-label="Folder name"
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
      />
      <button className={styles.primary} type="button" disabled={typed === null || busy} onClick={save}>
        Save
      </button>
      <button className={styles.secondary} type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function countOf(folder: NoteFolderView): string {
  const n = folder.noteIds.length;
  return `${n} ${n === 1 ? 'note' : 'notes'}`;
}
