import { foldersOfNote, type NoteFolderView } from '@thp/shared';

/**
 * **Which folder the *My notes* list is narrowed to** — pure, so the page and a unit test answer
 * it the same way. `all` is every thread; `unfiled` is every thread whose root is in none of the
 * member's folders (a thread the member only replied to is never filed, so it is unfiled); a
 * folder id is the threads whose root is filed there.
 *
 * Component state, and deliberately not remembered across a reload, as the visibility filter is
 * not. A folder that no longer exists is read as `all` rather than as an empty list, so removing
 * the folder being viewed shows everything instead of nothing.
 */
export type FolderFilter = 'all' | 'unfiled' | { readonly folderId: string };

export function passesFolderFilter(
  folders: readonly NoteFolderView[] | null,
  filter: FolderFilter,
  noteId: string,
): boolean {
  if (filter === 'all' || folders === null) return true;
  if (filter === 'unfiled') return foldersOfNote(folders, noteId).length === 0;
  const folder = folders.find((one) => one.id === filter.folderId);
  if (folder === undefined) return true;
  return folder.noteIds.includes(noteId);
}

/** Whether two filters are the same choice — what marks the selected pill. */
export function sameFolderFilter(a: FolderFilter, b: FolderFilter): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.folderId === b.folderId;
}
