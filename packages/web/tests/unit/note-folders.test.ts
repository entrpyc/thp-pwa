import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_FOLDER_NAME_LENGTH,
  foldersOfNote,
  normaliseNoteFolderName,
  type NoteFolderView,
} from '@thp/shared';
import { passesFolderFilter, sameFolderFilter } from '@/app/(member)/notes/folder-filter';
import { parseFolderIds, parseName } from '@/server/notes/folders';
import { ApiError } from '@/server/api/errors';

/**
 * **Note folders, the pure parts** — the name rule the picker and the API share, the lookup every
 * pill makes, the *My notes* folder filter, and the two body parsers. None of it needs a database
 * or a browser; what is pinned is that the two ends agree.
 */

const FOLDERS: readonly NoteFolderView[] = [
  { id: 'f-sermons', name: 'Sermons', noteIds: ['n1', 'n2'], createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'f-prayer', name: 'Prayer', noteIds: ['n2'], createdAt: '2026-11-02T00:00:00.000Z' },
  { id: 'f-empty', name: 'Empty', noteIds: [], createdAt: '2026-11-03T00:00:00.000Z' },
];

describe('a folder name', () => {
  it('is trimmed and its inner whitespace collapsed', () => {
    expect(normaliseNoteFolderName('  Sunday   sermons ')).toBe('Sunday sermons');
  });

  it('refuses nothing, blanks, non-strings and names past the ceiling', () => {
    expect(normaliseNoteFolderName('')).toBeNull();
    expect(normaliseNoteFolderName('   ')).toBeNull();
    expect(normaliseNoteFolderName(42)).toBeNull();
    expect(normaliseNoteFolderName(undefined)).toBeNull();
    expect(normaliseNoteFolderName('x'.repeat(MAX_NOTE_FOLDER_NAME_LENGTH))).toHaveLength(MAX_NOTE_FOLDER_NAME_LENGTH);
    expect(normaliseNoteFolderName('x'.repeat(MAX_NOTE_FOLDER_NAME_LENGTH + 1))).toBeNull();
  });

  it('is what the API parses off a body, with one refusal for every bad shape', () => {
    expect(parseName({ name: ' Grace ' })).toBe('Grace');
    for (const bad of [null, 'Grace', {}, { name: '' }, { name: 7 }]) {
      expect(() => parseName(bad)).toThrow(ApiError);
    }
  });
});

describe('which folders a note is in', () => {
  it('answers in the list’s order, and empty for an unfiled note', () => {
    expect(foldersOfNote(FOLDERS, 'n2').map((one) => one.id)).toEqual(['f-sermons', 'f-prayer']);
    expect(foldersOfNote(FOLDERS, 'n1').map((one) => one.id)).toEqual(['f-sermons']);
    expect(foldersOfNote(FOLDERS, 'n9')).toEqual([]);
  });
});

describe('the My notes folder filter', () => {
  it('passes everything for All, and for anything while the folders have not loaded', () => {
    expect(passesFolderFilter(FOLDERS, 'all', 'n9')).toBe(true);
    expect(passesFolderFilter(null, 'unfiled', 'n1')).toBe(true);
    expect(passesFolderFilter(null, { folderId: 'f-sermons' }, 'n9')).toBe(true);
  });

  it('passes only the notes in a folder, and only the notes in none for Unfiled', () => {
    expect(passesFolderFilter(FOLDERS, { folderId: 'f-sermons' }, 'n1')).toBe(true);
    expect(passesFolderFilter(FOLDERS, { folderId: 'f-prayer' }, 'n1')).toBe(false);
    expect(passesFolderFilter(FOLDERS, 'unfiled', 'n1')).toBe(false);
    expect(passesFolderFilter(FOLDERS, 'unfiled', 'n9')).toBe(true);
  });

  it('reads a folder that no longer exists as All rather than as nothing', () => {
    expect(passesFolderFilter(FOLDERS, { folderId: 'f-gone' }, 'n9')).toBe(true);
  });

  it('tells two choices apart by kind and by folder', () => {
    expect(sameFolderFilter('all', 'all')).toBe(true);
    expect(sameFolderFilter('all', 'unfiled')).toBe(false);
    expect(sameFolderFilter({ folderId: 'a' }, { folderId: 'a' })).toBe(true);
    expect(sameFolderFilter({ folderId: 'a' }, { folderId: 'b' })).toBe(false);
    expect(sameFolderFilter({ folderId: 'a' }, 'all')).toBe(false);
  });
});

describe('the filing body', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('is a list of folder ids, duplicates folded and case lowered', () => {
    expect(parseFolderIds({ folderIds: [A, A.toUpperCase(), B] })).toEqual([A, B]);
    expect(parseFolderIds({ folderIds: [] })).toEqual([]);
  });

  it('refuses anything that is not a list of uuids', () => {
    for (const bad of [null, {}, { folderIds: 'a' }, { folderIds: ['nope'] }, { folderIds: [1] }]) {
      expect(() => parseFolderIds(bad)).toThrow(ApiError);
    }
  });
});
