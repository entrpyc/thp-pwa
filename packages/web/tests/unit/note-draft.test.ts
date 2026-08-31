import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNoteDraft,
  noteDraftKey,
  readNoteDraft,
  writeNoteDraft,
} from '@/client/notes/draft';

/**
 * **The unsaved note** — kept in local storage so a closed tab does not cost a paragraph.
 *
 * The suite runs against a stand-in `localStorage` rather than a browser, because everything
 * worth asserting here is about *what is stored and what is read back*: the round trip, the shapes
 * that must be refused, and the promise that a storage which refuses to work costs the member
 * nothing. None of those needs a DOM, and a jsdom would only make them slower to run.
 */

const RECORDING = 'a3f1c2d4-0000-4000-8000-000000000001';

function fakeStorage(): Storage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  } as Storage & { readonly map: Map<string, string> };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a note in progress survives leaving the screen', () => {
  it('gives back the paragraph, the audience and the moment it was anchored to', () => {
    writeNoteDraft(RECORDING, {
      text: 'The bit about the fig tree.',
      visibility: 'public',
      anchorMs: 3_725_000,
    });

    // All three, because a note is a paragraph *and* the second it is about (3.1.1) *and* who will
    // read it (3.1.5) — restoring the words alone would hand back a different note.
    expect(readNoteDraft(RECORDING)).toEqual({
      text: 'The bit about the fig tree.',
      visibility: 'public',
      anchorMs: 3_725_000,
    });
  });

  it('keeps one draft per teaching, so two open composers are not two notes', () => {
    const other = 'a3f1c2d4-0000-4000-8000-000000000002';
    writeNoteDraft(RECORDING, { text: 'About this one.', visibility: 'private', anchorMs: 10_000 });
    writeNoteDraft(other, { text: 'About that one.', visibility: 'private', anchorMs: 20_000 });

    expect(readNoteDraft(RECORDING)?.text).toBe('About this one.');
    expect(readNoteDraft(other)?.text).toBe('About that one.');
    // Namespaced, so nothing else in the origin's local storage can collide with a draft.
    expect(noteDraftKey(RECORDING).startsWith('thp:note-draft:')).toBe(true);
  });

  it('is gone once the note it held has been saved', () => {
    writeNoteDraft(RECORDING, { text: 'Saved in a moment.', visibility: 'private', anchorMs: 1 });
    clearNoteDraft(RECORDING);
    expect(readNoteDraft(RECORDING)).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

describe('an empty composer is not a draft', () => {
  it.each(['', '   ', '\n\t '])('stores nothing for %j, and clears what was there', (text) => {
    writeNoteDraft(RECORDING, { text: 'Something real.', visibility: 'private', anchorMs: 5_000 });
    writeNoteDraft(RECORDING, { text, visibility: 'private', anchorMs: 5_000 });

    // A member who has cleared the box has no note in progress. A stored blank would reopen the
    // composer claiming to hold something and holding nothing.
    expect(readNoteDraft(RECORDING)).toBeNull();
    expect(storage.map.size).toBe(0);
  });
});

describe('what comes back is checked rather than trusted', () => {
  it.each([
    ['not JSON at all', 'a paragraph somebody stored'],
    ['a JSON value that is not an object', '"just a string"'],
    ['null', 'null'],
    ['no text', JSON.stringify({ visibility: 'private', anchorMs: 1 })],
    ['text that is not a string', JSON.stringify({ text: 4, visibility: 'private', anchorMs: 1 })],
    ['a visibility this product has no column for', JSON.stringify({ text: 'x', visibility: 'group', anchorMs: 1 })],
    ['no visibility', JSON.stringify({ text: 'x', anchorMs: 1 })],
    ['no anchor', JSON.stringify({ text: 'x', visibility: 'private' })],
    ['an anchor before the start', JSON.stringify({ text: 'x', visibility: 'private', anchorMs: -1 })],
    ['an anchor that is not a number', JSON.stringify({ text: 'x', visibility: 'private', anchorMs: '1' })],
  ])('refuses %s', (_case, raw) => {
    storage.map.set(noteDraftKey(RECORDING), raw);
    // The string is one this origin wrote, but an older version of this code may have written it —
    // and a `visibility` outside the two would reach the API as a refusal nobody can explain.
    expect(readNoteDraft(RECORDING)).toBeNull();
  });
});

describe('storage that will not work costs the member nothing', () => {
  it('reads null and writes nothing when there is no window at all', () => {
    vi.stubGlobal('window', undefined);
    expect(readNoteDraft(RECORDING)).toBeNull();
    expect(() => writeNoteDraft(RECORDING, { text: 'x', visibility: 'private', anchorMs: 1 })).not.toThrow();
    expect(() => clearNoteDraft(RECORDING)).not.toThrow();
  });

  it('survives a browser that throws on the accessor itself', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('site data is blocked');
      },
    });
    expect(readNoteDraft(RECORDING)).toBeNull();
    expect(() => writeNoteDraft(RECORDING, { text: 'x', visibility: 'private', anchorMs: 1 })).not.toThrow();
  });

  it('survives a full quota — the composer still holds the text either way', () => {
    vi.stubGlobal('window', {
      localStorage: {
        ...storage,
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    });
    expect(() =>
      writeNoteDraft(RECORDING, { text: 'A long one.', visibility: 'private', anchorMs: 1 }),
    ).not.toThrow();
  });
});
