'use client';

import { foldersOfNote } from '@thp/shared';
import noteStyles from '../recordings/[id]/notes.module.css';
import { useNoteFolders } from './note-folders-store';

/**
 * **Where a note is filed**, as pills in the card's head beside **Private** and **Pinned** — one
 * per folder, in the list's order, so a member can tell where a note is without opening the
 * picker. Nothing while the folders are loading or the note is unfiled: a head with no pill is
 * the ordinary case, and a placeholder would make every card flicker.
 */
export function NoteFolderPills({ noteId }: { noteId: string }) {
  const { folders } = useNoteFolders();
  if (folders === null) return null;
  const filed = foldersOfNote(folders, noteId);
  if (filed.length === 0) return null;
  return (
    <>
      {filed.map((one) => (
        <span key={one.id} className={noteStyles.folderPill} aria-label={`In folder ${one.name}`}>
          {one.name}
        </span>
      ))}
    </>
  );
}
