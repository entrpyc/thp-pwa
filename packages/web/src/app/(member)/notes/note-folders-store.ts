'use client';

import { useSyncExternalStore } from 'react';
import {
  NOTE_FOLDERS_PATH,
  noteFolderPath,
  noteFoldersPath,
  type CreateNoteFolderRequest,
  type NoteFolderView,
  type NoteFoldersPayload,
  type RenameNoteFolderRequest,
  type SetNoteFoldersRequest,
  foldersOfNote,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { track } from '@/client/observability/analytics';

/**
 * **The member's note folders, held once per page load** — what every folder control, every
 * folder pill and the *My notes* folder row read, and what every create, rename, remove and
 * filing writes back.
 *
 * **A module-level store rather than a provider**, for the reason the Highlights store is one:
 * the recording page mounts a folder control on every note of one's own, the *My notes* page
 * mounts one per card and a pill row above them, and a hook that fetched per mount would be
 * dozens of identical requests. A store any number of hooks subscribe to is one fetch per page,
 * no layout edit, and one answer to "which folders is this note in" on every surface at once,
 * because every write replaces the whole list with what the API answered.
 *
 * **It fetches when the first subscriber arrives and again whenever the count returns from
 * zero** — a navigation to a new surface — and never on a timer. A list that fails to load is
 * reported through `failure` and the controls render disabled rather than guessing; the next
 * subscriber retries.
 *
 * Session state only: it lives as long as the document. Nothing here is written to storage.
 */

export interface NoteFoldersSnapshot {
  /** The folders as last answered, or `null` until the first fetch lands — or after it fails. */
  readonly folders: readonly NoteFolderView[] | null;
  /** A write or the load in flight. Controls disable while it is, so two presses are one request. */
  readonly busy: boolean;
  readonly failure: string | null;
}

const LOAD_FAILED = 'Could not load your folders. Reload the page to try again.';
const WRITE_FAILED = 'Could not change your folders. Nothing has changed — try again in a moment.';

const EMPTY: NoteFoldersSnapshot = { folders: null, busy: false, failure: null };

let snapshot: NoteFoldersSnapshot = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<NoteFoldersSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  set({ busy: true, failure: null });
  try {
    const payload = await apiFetch<NoteFoldersPayload>(NOTE_FOLDERS_PATH, { credentials: 'include' });
    set({ folders: payload.folders, busy: false });
  } catch {
    set({ folders: null, busy: false, failure: LOAD_FAILED });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void load();
  return () => {
    listeners.delete(listener);
  };
}

function read(): NoteFoldersSnapshot {
  return snapshot;
}

function readOnServer(): NoteFoldersSnapshot {
  return EMPTY;
}

/** The sentence a dialog prints for a failed write — the API's when it gave one, ours otherwise. */
export function folderFailureMessage(caught: unknown): string {
  return caught instanceof ApiClientError ? caught.message : WRITE_FAILED;
}

/**
 * One write, whatever its verb: hold what the API answered, or record the failure and rethrow so
 * the dialog that pressed can print it beside the field.
 */
async function write(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<readonly NoteFolderView[]> {
  set({ busy: true, failure: null });
  try {
    const payload = await apiFetch<NoteFoldersPayload>(path, {
      method,
      credentials: 'include',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    set({ folders: payload.folders, busy: false });
    return payload.folders;
  } catch (caught) {
    set({ busy: false, failure: folderFailureMessage(caught) });
    throw caught;
  }
}

/** Create a folder and answer it, found in the list the API returned by its (normalised) name. */
async function create(name: string): Promise<NoteFolderView | null> {
  const request: CreateNoteFolderRequest = { name };
  const folders = await write(NOTE_FOLDERS_PATH, 'POST', request);
  // Counted once the API holds it, so a refused name (a duplicate, the cap) counts nothing.
  track('note_folder_created', { folder_count: folders.length });
  const wanted = name.trim().replace(/\s+/g, ' ').toLowerCase();
  return folders.find((one) => one.name.toLowerCase() === wanted) ?? null;
}

async function rename(folderId: string, name: string): Promise<void> {
  const request: RenameNoteFolderRequest = { name };
  await write(noteFolderPath(folderId), 'PATCH', request);
}

async function remove(folderId: string): Promise<void> {
  await write(noteFolderPath(folderId), 'DELETE');
}

async function setFolders(noteId: string, folderIds: readonly string[]): Promise<void> {
  const request: SetNoteFoldersRequest = { folderIds };
  const before = new Set(foldersOfNote(snapshot.folders ?? [], noteId).map((one) => one.id));
  const after = new Set(folderIds);
  await write(noteFoldersPath(noteId), 'PUT', request);
  // What changed, as the member saw it: the folders ticked that were not, and the reverse. A save
  // with nothing changed is a dismissal, not a filing, and sends nothing.
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  if (added === 0 && removed === 0) return;
  track('note_filed', { added, removed, folder_count: after.size });
}

export interface NoteFoldersApi extends NoteFoldersSnapshot {
  create(name: string): Promise<NoteFolderView | null>;
  rename(folderId: string, name: string): Promise<void>;
  remove(folderId: string): Promise<void>;
  /** Replace the set of the member's folders this note is in. */
  setFolders(noteId: string, folderIds: readonly string[]): Promise<void>;
}

/** The four writes, callable without React: what the hook hands out, and what a test drives. */
export const noteFolderWrites = { create, rename, remove, setFolders } as const;

export function useNoteFolders(): NoteFoldersApi {
  const state = useSyncExternalStore(subscribe, read, readOnServer);
  return { ...state, ...noteFolderWrites };
}
