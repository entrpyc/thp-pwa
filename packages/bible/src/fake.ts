import { formatCitation, type ScriptureCitation } from '@thp/shared';
import { NO_TEXT, type BibleSource, type Passage, type Verse } from './source';

/**
 * A verse source that reaches nothing.
 *
 * **Configuration, not a mock.** `BIBLE_SOURCE=fake` is a value of the same setting `free-use` is,
 * exactly as `ASR_PROVIDER=fake` and `MAIL_TRANSPORT=capture` are — so "the suite reaches no Bible
 * source" is a property of how the process was configured rather than of a stub somebody remembered
 * to install in each file. `THP_MOCK_EXTERNAL=true` forces it, which is
 * scope prd 3.3.10.
 *
 * **It answers with a stand-in that says what it is**, rather than with scripture. Two reasons, and
 * neither is convenience: a development database must not fill up with real verse text nobody
 * checked the licence on, and an admin looking at a review screen has to be able to tell at a glance
 * that they are looking at a fake rather than at a translation that reads oddly.
 *
 * Unlike the ASR and generation fakes it reads no script off disk. Those two stand in for an answer
 * with structure in it — segments, a summary — and a file is the only honest way to supply one.
 * This one stands in for a sentence, so a file would be a variable to set, a fixture to keep and a
 * failure mode to explain, for a sentence.
 */
export function fakeBibleSource(): BibleSource {
  return {
    name: 'fake',

    async readPassage(citation: ScriptureCitation): Promise<Passage> {
      const verses: Verse[] = [];
      for (let number = citation.verseStart; number <= citation.verseEnd; number += 1) {
        // **Named after the verse, never after the range it was asked for.** The cache holds one
        // row per verse, so a verse first fetched inside a whole-chapter request keeps whatever
        // text it was written with — and text that varied by the asking range would make that
        // stored row disagree with the same verse fetched on its own.
        const verse = { ...citation, verseStart: number, verseEnd: number };
        verses.push({ number, text: `Stand-in verse text for ${formatCitation(verse)}.` });
      }
      // A citation with no verses in it is not a citation, but the loop above would answer one with
      // an empty passage that read as a source failure. Said once, here.
      return verses.length === 0 ? NO_TEXT : { verses, requestId: null };
    },
  };
}
