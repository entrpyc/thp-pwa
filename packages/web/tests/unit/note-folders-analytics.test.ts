import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteFolderView } from '@thp/shared';

/**
 * **What the folders store tells analytics** (docs/project/observability.md § 5.2): a folder made
 * counts once the API holds it, a note filed counts by what changed, and a save that changed
 * nothing — or a write that failed — counts nothing.
 */

const apiFetch = vi.fn();
const track = vi.fn();
vi.mock('@/client/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiClientError: class extends Error {},
}));
vi.mock('@/client/observability/analytics', () => ({ track: (...args: unknown[]) => track(...args) }));

const NOTE = 'a3f1c2d4-0000-4000-8000-000000000001';
const SERMONS = 'b4e2d3c5-0000-4000-8000-000000000002';
const PRAYER = 'c5f3e4d6-0000-4000-8000-000000000003';

function folder(id: string, noteIds: readonly string[]): NoteFolderView {
  return { id, name: id, noteIds, createdAt: '2026-11-07T00:00:00.000Z' };
}

async function store() {
  vi.resetModules();
  return import('@/app/(member)/notes/note-folders-store');
}

beforeEach(() => {
  apiFetch.mockReset();
  track.mockReset();
});

describe('note folder analytics', () => {
  it('counts a folder once the API holds it, with how many the member has', async () => {
    apiFetch.mockResolvedValueOnce({ folders: [folder(SERMONS, []), folder(PRAYER, [])] });
    const { noteFolderWrites } = await store();
    await noteFolderWrites.create('Prayer');
    expect(track).toHaveBeenCalledWith('note_folder_created', { folder_count: 2 });
  });

  it('counts nothing for a folder the API refused', async () => {
    apiFetch.mockRejectedValueOnce(new Error('refused'));
    const { noteFolderWrites } = await store();
    await expect(noteFolderWrites.create('Prayer')).rejects.toThrow();
    expect(track).not.toHaveBeenCalled();
  });

  it('reports a filing by what changed', async () => {
    // The note is in SERMONS; the member ticks PRAYER and unticks SERMONS.
    apiFetch
      .mockResolvedValueOnce({ folders: [folder(SERMONS, [NOTE]), folder(PRAYER, [])] })
      .mockResolvedValueOnce({ folders: [folder(SERMONS, []), folder(PRAYER, [NOTE])] });
    const { noteFolderWrites } = await store();
    await noteFolderWrites.create('seed');
    track.mockReset();
    await noteFolderWrites.setFolders(NOTE, [PRAYER]);
    expect(track).toHaveBeenCalledWith('note_filed', { added: 1, removed: 1, folder_count: 1 });
  });

  it('sends nothing for a save that changed nothing', async () => {
    apiFetch
      .mockResolvedValueOnce({ folders: [folder(SERMONS, [NOTE])] })
      .mockResolvedValueOnce({ folders: [folder(SERMONS, [NOTE])] });
    const { noteFolderWrites } = await store();
    await noteFolderWrites.create('seed');
    track.mockReset();
    await noteFolderWrites.setFolders(NOTE, [SERMONS]);
    expect(track).not.toHaveBeenCalled();
  });
});
