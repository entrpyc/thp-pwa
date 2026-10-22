import { describe, expect, it } from 'vitest';
import { BLOCKED_WORDS } from '@/server/notes/blocked-words';
import { BLOCKED_WORD_MESSAGE, findBlockedWord } from '@/server/notes/filter';

/**
 * **The word filter is a floor, and only a floor** (Apple guideline 1.2).
 *
 * What is pinned is the *shape* of the rule rather than the list: whole words, case-insensitive,
 * punctuation ignored, substrings never matched, and a message that quotes nothing back. The list
 * itself is asserted for hygiene — lower-case, single words, no duplicates — because a stray
 * capital or a space would silently stop an entry from ever matching.
 */

/** An entry from the list, so the tests do not spell one of their own. */
const WORD = BLOCKED_WORDS[0] ?? '';

describe('the word list', () => {
  it('is lower-case, one word per entry, with no duplicates and nothing empty', () => {
    expect(BLOCKED_WORDS.length).toBeGreaterThan(0);
    for (const entry of BLOCKED_WORDS) {
      expect(entry).toBe(entry.toLowerCase().trim());
      expect(entry).toMatch(/^\S+$/);
    }
    expect(new Set(BLOCKED_WORDS).size).toBe(BLOCKED_WORDS.length);
  });

  it('keeps the words with ordinary meanings a study note needs out', () => {
    for (const ordinary of ['ass', 'damn', 'hell', 'cock', 'god', 'death', 'kill']) {
      expect(BLOCKED_WORDS).not.toContain(ordinary);
    }
  });
});

describe('findBlockedWord', () => {
  it('answers null for ordinary text, including text in another script', () => {
    expect(findBlockedWord('Grace upon grace — what a moment at 12:40.')).toBeNull();
    expect(findBlockedWord('Благодат върху благодат.')).toBeNull();
    expect(findBlockedWord('')).toBeNull();
  });

  it('matches a listed word as a whole word, whatever the case and the punctuation round it', () => {
    expect(findBlockedWord(`What a ${WORD} of a day.`)).toBe(WORD);
    expect(findBlockedWord(`${WORD.toUpperCase()}!`)).toBe(WORD);
    expect(findBlockedWord(`"${WORD}", he said.`)).toBe(WORD);
    expect(findBlockedWord(`line one\n${WORD}\nline three`)).toBe(WORD);
  });

  it('never matches a listed word inside a longer word — the floor is not a substring search', () => {
    expect(findBlockedWord(`un${WORD}able`)).toBeNull();
    expect(findBlockedWord(`${WORD}ometer`)).toBeNull();
    // The classic: a place name that contains a listed word is still a place name.
    expect(findBlockedWord('Scunthorpe United')).toBeNull();
  });

  it('does not chase spelling variants or leetspeak', () => {
    expect(findBlockedWord(WORD.replace(/[aeiou]/, '*'))).toBeNull();
    expect(findBlockedWord(WORD.split('').join('.'))).toBeNull();
  });

  it('answers the first listed word, so a log line can carry the word without the note', () => {
    const second = BLOCKED_WORDS[1] ?? WORD;
    expect(findBlockedWord(`${second} and ${WORD}`)).toBe(second);
  });

  it('refuses with a sentence that quotes nothing and says what to do', () => {
    for (const entry of BLOCKED_WORDS) {
      expect(BLOCKED_WORD_MESSAGE.toLowerCase()).not.toContain(entry);
    }
    expect(BLOCKED_WORD_MESSAGE).toMatch(/try again/i);
  });
});
