/**
 * **The Bible-text port — what a verse source is, as far as this application is concerned.**
 *
 * One interface, one adapter behind it, and the source named in configuration rather than in code —
 * the same shape as the ASR, generation, mail and media boundaries, and enforced the same way:
 * tests/guards/bible-boundary.test.ts fails the build if anything outside the adapter names a Bible
 * API. That is what makes the worker and the API resolve a passage *the same way*
 * ([3.1.1](docs/active-scope/implementation-plan.md)) rather than each reaching for a source of its
 * own.
 *
 * The port takes **a citation** and answers with **the verses of it, one by one**. Verse by verse
 * rather than as one paragraph, because that is the grain the cache is keyed at
 * ([3.3.1](docs/active-scope/prd.md)): a verse fetched for one teaching is a verse already held for
 * the next, whatever range the next teaching cites it in.
 *
 * **Nothing here throws.** A source that fails, times out, or simply has no text for a passage
 * answers with *no verses* ([3.1.5](docs/active-scope/prd.md)), because every caller does the same
 * thing with all three: keeps the citation and records that it has no text yet. An exception would
 * make each caller interpret a failure it has no way to act on, and the one caller that forgot
 * would fail a pipeline step over a convenience ([3.3.5](docs/active-scope/prd.md)).
 */

import type { ScriptureCitation } from '@thp/shared';

/** One verse of a passage: which verse it is, and what the source says it says. */
export interface Verse {
  readonly number: number;
  readonly text: string;
}

/**
 * What a source answered with.
 *
 * `verses` is empty when there is no text — the failure, the timeout and the empty passage are the
 * same answer here, deliberately.
 *
 * `requestId` is **the source's own identifier for the call** ([3.3.9](docs/active-scope/prd.md)),
 * which is what completes the correlation span from our job row into somebody else's logs. `null`
 * when the source gave none, which a local fake never does.
 */
export interface Passage {
  readonly verses: readonly Verse[];
  readonly requestId: string | null;
}

/** A passage with no text, in the one place the empty answer is spelled. */
export const NO_TEXT: Passage = { verses: [], requestId: null };

export interface BibleSource {
  /** Which adapter is in use, for the log line. Never a source decision made in code. */
  readonly name: string;
  /**
   * The verses of this citation, in verse order. Never rejects: see the note above.
   *
   * A source that has *some* of the range answers with what it has — a short list is a real
   * answer, and the verses it does hold are worth holding.
   */
  readPassage(citation: ScriptureCitation): Promise<Passage>;
}
