import { describe, expect, it } from 'vitest';
import {
  MAX_NOTE_IMAGES,
  MAX_NOTE_IMAGE_ALT_LENGTH,
  NOTE_IMAGE_MAX_EDGE,
  excerptForImages,
  imageFallbackAlt,
  isPendingImageRef,
  noteImagePath,
} from '@thp/shared';
import { fitWithin } from '@/client/artwork/encode';
import { prepareOutboxImages } from '@/client/offline/pending-images';
import type { OutboxRecord } from '@/client/offline/schema';

/**
 * **Pictures on notes** ([3.12.22](docs/project/prd.md)–[3.12.25](docs/project/prd.md)), the parts
 * with no browser and no store in the room: the ceilings, the sentences, the path, the resize, and
 * the flush's rule that an entry with nothing pending passes straight through.
 */

describe('the ceilings and the sentences', () => {
  it('allows three pictures, two hundred characters of description, and a long edge of 1600', () => {
    expect(MAX_NOTE_IMAGES).toBe(3);
    expect(MAX_NOTE_IMAGE_ALT_LENGTH).toBe(200);
    expect(NOTE_IMAGE_MAX_EDGE).toBe(1600);
    expect(fitWithin(4000, 3000, NOTE_IMAGE_MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
  });

  it('says Photo for a note of pictures alone, and names a picture by its place when undescribed', () => {
    expect(excerptForImages(1)).toBe('Photo');
    expect(excerptForImages(3)).toBe('3 photos');
    expect(imageFallbackAlt(0, 1)).toBe('Image');
    expect(imageFallbackAlt(1, 3)).toBe('Image 2 of 3');
  });

  it('addresses one picture under its note, and tells a pending reference from the rest', () => {
    expect(noteImagePath('n1', 'i1')).toBe('/notes/n1/images/i1');
    expect(isPendingImageRef({ pending: 'p' })).toBe(true);
    expect(isPendingImageRef({ key: 'note-images/x.webp' })).toBe(false);
  });
});

describe('the flush', () => {
  it('passes entries with no pending pictures straight through, touching nothing', async () => {
    const records: OutboxRecord[] = [
      { clientId: 'a', userId: 'u', kind: 'progress', recordingId: 'r', at: '2026-10-23T00:00:00.000Z', body: { positionMs: 1 } },
      {
        clientId: 'b',
        userId: 'u',
        kind: 'note',
        recordingId: 'r',
        at: '2026-10-23T00:00:00.000Z',
        body: { text: 'words', visibility: 'private', timestampMs: 0, images: [{ key: 'note-images/k.webp', alt: null }] },
      },
    ];
    const prepared = await prepareOutboxImages(records, async () => {
      throw new Error('no grant should be asked for');
    });
    expect(prepared.ready).toEqual(records);
    expect(prepared.heldBack).toBe(0);
    expect(prepared.pendingIds).toEqual([]);
  });
});
