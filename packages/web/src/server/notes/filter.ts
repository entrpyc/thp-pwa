import { BLOCKED_WORDS } from './blocked-words';

/**
 * **The write-time check on note text** (Apple guideline 1.2: a method for filtering objectionable
 * material). Server-side, because the client holds no decision; at write time, because the
 * alternative — storing the note and hiding it — is a note that exists and that an admin has to
 * find.
 *
 * **Whole words, case-insensitive, and that is the whole rule.** A note is split on anything that
 * is not a letter or a digit, each piece is lower-cased and looked up in the set. A word inside a
 * longer word is not a match (`class` does not contain a hit, `Scunthorpe` does not), and a word
 * with punctuation round it is (`word!`, `"word"`). Unicode letters count as letters, so a
 * Cyrillic note is split correctly even though the list has nothing to find in it today.
 *
 * **Conservative on purpose.** The list is a floor (`blocked-words.ts` says why), and this function
 * does nothing to widen it: no substring matching, no leetspeak normalisation, no edit distance.
 * Each of those catches more and each refuses an honest note sooner, and a refused honest note
 * costs a member their words. The product's answer to what this misses is the report path.
 *
 * Answers the first word it found, lower-cased, so the caller can log *that* a word was refused
 * without logging the note — the sentence a member reads never quotes it either.
 */
export function findBlockedWord(text: string): string | null {
  for (const piece of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (piece !== '' && BLOCKED.has(piece)) return piece;
  }
  return null;
}

/**
 * What the member reads. It says what to do and does not repeat the word: a refusal that quoted
 * the word back would be the product saying it, and the member knows which one they wrote.
 */
export const BLOCKED_WORD_MESSAGE =
  'This note contains language the group does not allow. Edit the wording and try again.';

const BLOCKED: ReadonlySet<string> = new Set(BLOCKED_WORDS);
