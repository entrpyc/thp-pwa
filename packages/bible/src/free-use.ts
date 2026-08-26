import { findBook, verseCount, type ScriptureCitation } from '@thp/shared';
import { readBibleBaseUrl, readBibleTranslation, type EnvSource } from './env';
import { NO_TEXT, type BibleSource, type Passage, type Verse } from './source';

/**
 * **The one file in the repository permitted to name a Bible text source** —
 * tests/guards/bible-boundary.test.ts fails the build if a second one appears, exactly as
 * `worker/src/generate/minimax.ts` is the one file permitted to name the generation provider and
 * `worker/src/asr/deepgram.ts` the one permitted to name a transcription provider.
 *
 * It speaks the Free Use Bible API over plain `fetch`. No SDK: the call is one `GET` at a static
 * JSON document, and a dependency to make that shorter would be a dependency between this
 * application and somebody's release cadence for no gain.
 *
 * **Three things about the source are held here and nowhere else**, which is what
 * scope plan 3.1.2 means by "its HTTP shape":
 *
 * 1. **The URL** — `{base}/api/{translation}/{book}/{chapter}.simple.json`.
 * 2. **The book codes.** The source names books by their standard three-letter code, and the canon
 *    names them by the identity a stored citation carries. That mapping is a fact about the source,
 *    not about the canon, so it lives with the source.
 * 3. **The simple format.** The source publishes each chapter twice — once with the poetry
 *    indentation, the words of Jesus and the footnote callers marked up, and once as plain
 *    sentences. This asks for the plain one, because scope prd says verse
 *    text is plain text: markup we would only have to strip is markup not worth fetching.
 *
 * **Nothing here throws**, which is the port's promise (scope prd 3.1.5) and the
 * reason scope prd 3.3.5's pipeline step stays green when the source is down.
 * Every way of having no text — a refusal, a timeout, a body in the wrong shape, a chapter that
 * does not hold the verses asked for — comes back as {@link NO_TEXT}.
 */

/**
 * How the source spells each book of the canon, keyed by the identity a citation carries.
 *
 * Keyed rather than positional: the canon's order is its sort key, and this file should not be able
 * to break it by having been written down in a different one.
 */
const BOOK_CODE: Readonly<Record<string, string>> = {
  genesis: 'GEN',
  exodus: 'EXO',
  leviticus: 'LEV',
  numbers: 'NUM',
  deuteronomy: 'DEU',
  joshua: 'JOS',
  judges: 'JDG',
  ruth: 'RUT',
  '1-samuel': '1SA',
  '2-samuel': '2SA',
  '1-kings': '1KI',
  '2-kings': '2KI',
  '1-chronicles': '1CH',
  '2-chronicles': '2CH',
  ezra: 'EZR',
  nehemiah: 'NEH',
  esther: 'EST',
  job: 'JOB',
  psalm: 'PSA',
  proverbs: 'PRO',
  ecclesiastes: 'ECC',
  'song-of-solomon': 'SNG',
  isaiah: 'ISA',
  jeremiah: 'JER',
  lamentations: 'LAM',
  ezekiel: 'EZK',
  daniel: 'DAN',
  hosea: 'HOS',
  joel: 'JOL',
  amos: 'AMO',
  obadiah: 'OBA',
  jonah: 'JON',
  micah: 'MIC',
  nahum: 'NAM',
  habakkuk: 'HAB',
  zephaniah: 'ZEP',
  haggai: 'HAG',
  zechariah: 'ZEC',
  malachi: 'MAL',
  matthew: 'MAT',
  mark: 'MRK',
  luke: 'LUK',
  john: 'JHN',
  acts: 'ACT',
  romans: 'ROM',
  '1-corinthians': '1CO',
  '2-corinthians': '2CO',
  galatians: 'GAL',
  ephesians: 'EPH',
  philippians: 'PHP',
  colossians: 'COL',
  '1-thessalonians': '1TH',
  '2-thessalonians': '2TH',
  '1-timothy': '1TI',
  '2-timothy': '2TI',
  titus: 'TIT',
  philemon: 'PHM',
  hebrews: 'HEB',
  james: 'JAS',
  '1-peter': '1PE',
  '2-peter': '2PE',
  '1-john': '1JN',
  '2-john': '2JN',
  '3-john': '3JN',
  jude: 'JUD',
  revelation: 'REV',
};

/**
 * The header the source's edge puts its own call identifier in. Read as an opaque string; what it
 * is for is quoting back when asking somebody else's logs about one of our calls.
 */
const REQUEST_ID_HEADER = 'x-amz-cf-id';

/**
 * Ten seconds. A ceiling rather than an expectation — the document is a cached static file and
 * arrives in well under one. What it stops is a review screen, or a pipeline step, waiting on a
 * source that has stopped answering: both would rather have no text than no answer.
 */
export const FREE_USE_TIMEOUT_MS = 10_000;

/** The `fetch` the adapter calls. A parameter so a unit test can drive a refusal without a network. */
export type HttpTransport = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface FreeUseOptions {
  readonly baseUrl?: string;
  readonly translation?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  readonly env?: EnvSource;
}

export function freeUseBibleSource(options: FreeUseOptions = {}): BibleSource {
  const { env = process.env, timeoutMs = FREE_USE_TIMEOUT_MS } = options;
  const baseUrl = options.baseUrl ?? readBibleBaseUrl(env);
  const translation = options.translation ?? readBibleTranslation(env);
  const transport = options.transport ?? (globalThis.fetch as unknown as HttpTransport);

  return {
    name: 'free-use',

    async readPassage(citation: ScriptureCitation): Promise<Passage> {
      const code = BOOK_CODE[citation.book];
      if (code === undefined) return NO_TEXT;

      const url = `${baseUrl}/api/${translation}/${code}/${citation.chapter}.simple.json`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await transport(url, { signal: controller.signal });
        if (!response.ok) return NO_TEXT;

        const verses = versesOf(JSON.parse(await response.text()), citation);
        if (verses.length === 0) return NO_TEXT;

        return { verses, requestId: response.headers.get(REQUEST_ID_HEADER) };
      } catch {
        // The refusal, the timeout and the body that was not JSON are the same event as far as a
        // caller is concerned: this passage has no text yet.
        return NO_TEXT;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The verses of the citation, out of a chapter document.
 *
 * The chapter's content is a mixed list — headings, blank lines, and the verses between them — so
 * the verses are picked out by their type rather than by position, and everything that is not one
 * is not part of the passage.
 */
function versesOf(body: unknown, citation: ScriptureCitation): Verse[] {
  const chapter = (body as { chapter?: { content?: unknown } } | null)?.chapter;
  const content = chapter?.content;
  if (!Array.isArray(content)) return [];

  const found: Verse[] = [];
  for (const entry of content) {
    const one = (entry ?? {}) as Record<string, unknown>;
    if (one['type'] !== 'verse') continue;
    const number = one['number'];
    const text = one['text'];
    if (typeof number !== 'number' || typeof text !== 'string') continue;
    if (number < citation.verseStart || number > citation.verseEnd) continue;
    found.push({ number, text });
  }
  return found.sort((a, b) => a.number - b.number);
}

/**
 * How this source spells a book, or `undefined` for one it has no code for.
 *
 * Exported for the adapter's own test rather than asserted at import time: a mapping that has lost
 * a book should fail a test, not a worker halfway through a teaching.
 */
export function bookCodeFor(book: string): string | undefined {
  return BOOK_CODE[book];
}

/** The last verse of the chapter a citation is in, per the canon's own versification. */
export function lastVerseOf(citation: ScriptureCitation): number {
  const book = findBook(citation.book);
  return book === null ? citation.verseEnd : verseCount(book, citation.chapter);
}
