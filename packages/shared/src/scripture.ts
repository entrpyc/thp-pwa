/**
 * **A scripture citation, and the 66-book canon it is checked against.**
 *
 * One value the whole product agrees on. The worker validates a model's proposal with it, the API
 * re-checks what a client sends, and the client renders it — so `Romans 8:1–4` means the same
 * thing, sorts to the same place and de-duplicates against the same key in all three.
 *
 * **The canon is declared once, here.** Each book carries its identity, the name a citation is
 * written with, and one verse count per chapter — which is what makes `Romans 51` and `John 3:99`
 * refusable rather than merely implausible. It is *structural* data about the text and not the
 * text: no verse is quoted here, and nothing in this file reaches a Bible source. Fetching the
 * words sits behind its own port in a later group.
 *
 * `tools/domain-declarations.ts` enforces both halves of that claim — no second declaration of
 * {@link BIBLE_BOOKS}, and no book name spelled in any other source file. Anything that needs to
 * print one calls {@link formatCitation}.
 */

/** One book of the canon: what it is called, and how long each of its chapters is. */
export interface BibleBook {
  /** The stable identity a stored citation carries. Never re-spelled once written. */
  readonly id: string;
  /** The name a citation is written with — `Psalm 23`, not `Psalms 23`. */
  readonly name: string;
  /** One entry per chapter, in order, holding that chapter's verse count. */
  readonly verses: readonly number[];
}

/**
 * **The 66-book Protestant canon, in canon order**, with the verse counts of the traditional
 * English versification.
 *
 * The array's order *is* the sort key ({@link compareCitations}) — Genesis sorts first because it
 * is first here, not because of anything about its name.
 *
 * The totals this table has to add up to are fixed and public — 1,189 chapters and 31,102 verses —
 * and `packages/web/tests/unit/scripture-citation.test.ts` asserts both. That is what turns a
 * mistyped number into a failing test rather than into one citation quietly refused for the rest
 * of the product's life.
 */
export const BIBLE_BOOKS: readonly BibleBook[] = [
  { id: 'genesis', name: 'Genesis', verses: [31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26] },
  { id: 'exodus', name: 'Exodus', verses: [22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,16,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38] },
  { id: 'leviticus', name: 'Leviticus', verses: [17,16,17,35,19,30,38,36,24,20,47,8,59,57,33,34,16,30,37,27,24,33,44,23,55,46,34] },
  { id: 'numbers', name: 'Numbers', verses: [54,34,51,49,31,27,89,26,23,36,35,16,33,45,41,50,13,32,22,29,35,41,30,25,18,65,23,31,40,16,54,42,56,29,34,13] },
  { id: 'deuteronomy', name: 'Deuteronomy', verses: [46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,29,20,30,52,29,12] },
  { id: 'joshua', name: 'Joshua', verses: [18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33] },
  { id: 'judges', name: 'Judges', verses: [36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25] },
  { id: 'ruth', name: 'Ruth', verses: [22,23,18,22] },
  { id: '1-samuel', name: '1 Samuel', verses: [28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13] },
  { id: '2-samuel', name: '2 Samuel', verses: [27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25] },
  { id: '1-kings', name: '1 Kings', verses: [53,46,28,34,18,38,51,66,28,29,43,33,34,31,34,34,24,46,21,43,29,53] },
  { id: '2-kings', name: '2 Kings', verses: [18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,41,37,37,21,26,20,37,20,30] },
  { id: '1-chronicles', name: '1 Chronicles', verses: [54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30] },
  { id: '2-chronicles', name: '2 Chronicles', verses: [17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23] },
  { id: 'ezra', name: 'Ezra', verses: [11,70,13,24,17,22,28,36,15,44] },
  { id: 'nehemiah', name: 'Nehemiah', verses: [11,20,32,23,19,19,73,18,38,39,36,47,31] },
  { id: 'esther', name: 'Esther', verses: [22,23,15,17,14,14,10,17,32,3] },
  { id: 'job', name: 'Job', verses: [22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,28,25,31,40,22,33,37,16,33,24,41,30,24,34,17] },
  { id: 'psalm', name: 'Psalm', verses: [6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,6,8,8,3,18,3,3,21,26,9,8,24,13,10,7,12,15,21,10,20,14,9,6] },
  { id: 'proverbs', name: 'Proverbs', verses: [33,22,35,27,23,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,29,35,34,28,28,27,28,27,33,31] },
  { id: 'ecclesiastes', name: 'Ecclesiastes', verses: [18,26,22,16,20,12,29,17,18,20,10,14] },
  { id: 'song-of-solomon', name: 'Song of Solomon', verses: [17,17,11,16,16,13,13,14] },
  { id: 'isaiah', name: 'Isaiah', verses: [31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24] },
  { id: 'jeremiah', name: 'Jeremiah', verses: [19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34] },
  { id: 'lamentations', name: 'Lamentations', verses: [22,22,66,22,22] },
  { id: 'ezekiel', name: 'Ezekiel', verses: [28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,14,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,15,38,28,23,29,49,26,20,27,31,25,24,23,35] },
  { id: 'daniel', name: 'Daniel', verses: [21,49,30,37,31,28,28,27,27,21,45,13] },
  { id: 'hosea', name: 'Hosea', verses: [11,23,5,19,15,11,16,14,17,15,12,14,16,9] },
  { id: 'joel', name: 'Joel', verses: [20,32,21] },
  { id: 'amos', name: 'Amos', verses: [15,16,15,13,27,14,17,14,15] },
  { id: 'obadiah', name: 'Obadiah', verses: [21] },
  { id: 'jonah', name: 'Jonah', verses: [17,10,10,11] },
  { id: 'micah', name: 'Micah', verses: [16,13,12,13,15,16,20] },
  { id: 'nahum', name: 'Nahum', verses: [15,13,19] },
  { id: 'habakkuk', name: 'Habakkuk', verses: [17,20,19] },
  { id: 'zephaniah', name: 'Zephaniah', verses: [18,15,20] },
  { id: 'haggai', name: 'Haggai', verses: [15,23] },
  { id: 'zechariah', name: 'Zechariah', verses: [21,13,10,14,11,15,14,23,17,12,17,14,9,21] },
  { id: 'malachi', name: 'Malachi', verses: [14,17,18,6] },
  { id: 'matthew', name: 'Matthew', verses: [25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20] },
  { id: 'mark', name: 'Mark', verses: [45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20] },
  { id: 'luke', name: 'Luke', verses: [80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53] },
  { id: 'john', name: 'John', verses: [51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25] },
  { id: 'acts', name: 'Acts', verses: [26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,41,38,40,30,35,27,27,32,44,31] },
  { id: 'romans', name: 'Romans', verses: [32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27] },
  { id: '1-corinthians', name: '1 Corinthians', verses: [31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24] },
  { id: '2-corinthians', name: '2 Corinthians', verses: [24,17,18,18,21,18,16,24,15,18,33,21,14] },
  { id: 'galatians', name: 'Galatians', verses: [24,21,29,31,26,18] },
  { id: 'ephesians', name: 'Ephesians', verses: [23,22,21,32,33,24] },
  { id: 'philippians', name: 'Philippians', verses: [30,30,21,23] },
  { id: 'colossians', name: 'Colossians', verses: [29,23,25,18] },
  { id: '1-thessalonians', name: '1 Thessalonians', verses: [10,20,13,18,28] },
  { id: '2-thessalonians', name: '2 Thessalonians', verses: [12,17,18] },
  { id: '1-timothy', name: '1 Timothy', verses: [20,15,16,16,25,21] },
  { id: '2-timothy', name: '2 Timothy', verses: [18,26,17,22] },
  { id: 'titus', name: 'Titus', verses: [16,15,15] },
  { id: 'philemon', name: 'Philemon', verses: [25] },
  { id: 'hebrews', name: 'Hebrews', verses: [14,18,19,16,14,20,28,13,28,39,40,29,25] },
  { id: 'james', name: 'James', verses: [27,26,18,17,20] },
  { id: '1-peter', name: '1 Peter', verses: [25,25,22,19,14] },
  { id: '2-peter', name: '2 Peter', verses: [21,22,18] },
  { id: '1-john', name: '1 John', verses: [10,29,24,21,21] },
  { id: '2-john', name: '2 John', verses: [13] },
  { id: '3-john', name: '3 John', verses: [14] },
  { id: 'jude', name: 'Jude', verses: [25] },
  { id: 'revelation', name: 'Revelation', verses: [20,29,22,11,14,17,17,13,21,11,19,17,18,20,8,21,18,24,21,15,27,21] },
];

/**
 * A book's stable identity, as a stored citation carries it.
 *
 * A name rather than an ordinal, so a row in the database and a payload on the wire are both
 * readable without the table above beside them. Canon *order* is the table's index and is never
 * derived from the id.
 */
export type BookId = string;

/**
 * **One citation.** Book, chapter, and a verse range within it.
 *
 * `verseStart` and `verseEnd` are always present and always within the chapter — equal for a
 * single verse, and spanning the chapter's whole length for a whole-chapter citation, which is
 * what {@link formatCitation} renders as the bare chapter. There is no third state for "the whole
 * chapter": a citation that covers every verse of a chapter *is* that chapter, and giving it a
 * second spelling would mean every comparison, sort and verse lookup carrying a null branch to
 * tell two identical facts apart.
 */
export interface ScriptureCitation {
  readonly book: BookId;
  readonly chapter: number;
  readonly verseStart: number;
  readonly verseEnd: number;
}

/**
 * A citation as somebody proposed it, before it is known to be one — the shape a model answers in
 * and the shape a form submits.
 *
 * `book` is **words**, not an identity: the model writes what it heard, and resolving that to a
 * book of the canon is exactly the step that can fail. Verses may be absent, which reads as the
 * whole chapter.
 */
export interface ProposedCitation {
  readonly book: string;
  readonly chapter: number;
  readonly verseStart?: number | null;
  readonly verseEnd?: number | null;
}

/** Which part of a citation is wrong, so a refusal can be shown against the input that caused it. */
export type CitationField = 'book' | 'chapter' | 'verse';

/** Why a proposal is not a citation, in words a person reads. */
export interface CitationProblem {
  readonly field: CitationField;
  readonly message: string;
}

/** The one validator's answer: the citation, or what is wrong with the proposal. */
export type CitationCheck =
  | { readonly ok: true; readonly citation: ScriptureCitation }
  | { readonly ok: false; readonly problem: CitationProblem };

/** The book with this identity, or `null`. */
export function findBook(id: string): BibleBook | null {
  return BIBLE_BOOKS.find((book) => book.id === id) ?? null;
}

/**
 * The book this text names, or `null`.
 *
 * Matches the identity or the name, trimmed and case-insensitively — enough for a model that
 * writes `romans` where the canon says `Romans`, and deliberately no more. Abbreviations, spelling
 * variants and alternative book names are not resolved: a citation this cannot place is dropped
 * and counted, which is visible, rather than guessed at, which is not.
 */
export function findBookByName(name: string): BibleBook | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return null;
  return BIBLE_BOOKS.find((book) => book.id === wanted || book.name.toLowerCase() === wanted) ?? null;
}

/** How many verses that chapter has, or `0` when the book has no such chapter. */
export function verseCount(book: BibleBook, chapter: number): number {
  return book.verses[chapter - 1] ?? 0;
}

/**
 * **The one validator.** Everything that decides whether a citation is real happens here — in the
 * worker before a draft is written, and in the API before a reference is stored.
 *
 * It answers with *what is wrong* rather than with a boolean, because every caller has to say so:
 * the worker records which citations it dropped and why, and the review form shows the refusal
 * against the row that caused it.
 *
 * Absent verses read as the whole chapter, so a proposal of `Psalm 23` with no verse numbers is a
 * citation rather than a refusal.
 */
export function checkCitation(input: ProposedCitation): CitationCheck {
  const book = findBookByName(input.book);
  if (book === null) {
    return { ok: false, problem: { field: 'book', message: `There is no book of the Bible called “${input.book}”.` } };
  }

  const chapter = input.chapter;
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > book.verses.length) {
    return {
      ok: false,
      problem: {
        field: 'chapter',
        message: `${book.name} has ${book.verses.length} chapters, so there is no chapter ${chapter}.`,
      },
    };
  }

  const last = verseCount(book, chapter);
  const verseStart = input.verseStart ?? 1;
  const verseEnd = input.verseEnd ?? last;

  if (!Number.isInteger(verseStart) || !Number.isInteger(verseEnd) || verseStart < 1 || verseEnd > last) {
    return {
      ok: false,
      problem: {
        field: 'verse',
        message: `${book.name} ${chapter} has ${last} verses, so there is no verse ${verseEnd > last ? verseEnd : verseStart} in it.`,
      },
    };
  }

  if (verseEnd < verseStart) {
    return {
      ok: false,
      problem: { field: 'verse', message: 'A range has to end at or after the verse it starts at.' },
    };
  }

  return { ok: true, citation: { book: book.id, chapter, verseStart, verseEnd } };
}

/**
 * What makes two citations the same passage.
 *
 * Declared once so a list can be de-duplicated without each caller inventing its own answer to
 * "the same" — the worker collapsing a model's repeats and the form refusing a duplicate an admin
 * added are the same comparison.
 */
export function citationKey(citation: ScriptureCitation): string {
  return `${citation.book}:${citation.chapter}:${citation.verseStart}-${citation.verseEnd}`;
}

/** Whether these two name the same passage. */
export function citationsEqual(a: ScriptureCitation, b: ScriptureCitation): boolean {
  return citationKey(a) === citationKey(b);
}

/**
 * Canon order — Genesis before Exodus, chapter 3 before chapter 12, verse 1 before verse 9.
 *
 * The book's position in {@link BIBLE_BOOKS} is the key, so the order is the canon's rather than
 * alphabetical. A book this does not recognise sorts last rather than throwing: ordering a list is
 * not where an unknown book should surface, and it already cannot be stored.
 */
export function compareCitations(a: ScriptureCitation, b: ScriptureCitation): number {
  const order = (id: BookId): number => {
    const index = BIBLE_BOOKS.findIndex((book) => book.id === id);
    return index < 0 ? BIBLE_BOOKS.length : index;
  };
  return (
    order(a.book) - order(b.book) ||
    a.chapter - b.chapter ||
    a.verseStart - b.verseStart ||
    a.verseEnd - b.verseEnd
  );
}

/**
 * **The citation as a person says it** — `John 3:16`, `Romans 8:1–4`, `Psalm 23`.
 *
 * One function, called by the review form and by the member's panel both, so the two surfaces
 * cannot drift. A range covering the whole chapter renders as the bare chapter, because that is
 * what it is.
 */
export function formatCitation(citation: ScriptureCitation): string {
  const book = findBook(citation.book);
  const name = book?.name ?? citation.book;
  const where = `${name} ${citation.chapter}`;

  if (book !== null && citation.verseStart === 1 && citation.verseEnd === verseCount(book, citation.chapter)) {
    return where;
  }
  if (citation.verseStart === citation.verseEnd) return `${where}:${citation.verseStart}`;
  return `${where}:${citation.verseStart}–${citation.verseEnd}`;
}

/**
 * Whether this value read out of `jsonb` or off the wire is a citation.
 *
 * Shape only — that the numbers are real chapters and verses is {@link checkCitation}'s question,
 * asked wherever a citation arrives from outside.
 */
export function isScriptureCitation(value: unknown): value is ScriptureCitation {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['book'] === 'string' &&
    Number.isInteger(entry['chapter']) &&
    Number.isInteger(entry['verseStart']) &&
    Number.isInteger(entry['verseEnd'])
  );
}

/**
 * Where a stored reference came from ([3.2.9](docs/active-scope/prd.md)).
 *
 * Declared here once and derived into the Postgres enum, as every other domain enum in the product
 * is. `person` is unreachable until an admin can add a reference by hand; the column exists now
 * because the row it lives on does.
 *
 * **`person` rather than `admin`.** This is not a role — nothing authorises against it, and it
 * answers *what put this reference here* rather than *who may*. Spelling it as a role would put a
 * role literal outside `roles.ts`, which tools/role-usage.ts refuses and is right to: the two
 * words meaning the same person today is a coincidence, not a fact to encode.
 */
export const SCRIPTURE_ORIGINS = ['machine', 'person'] as const;

export type ScriptureOrigin = (typeof SCRIPTURE_ORIGINS)[number];

/** One approved reference on a teaching, as the API answers with it. */
export interface ScriptureReferenceView extends ScriptureCitation {
  readonly origin: ScriptureOrigin;
  /** Whether an admin changed this reference before approving the list it was in. */
  readonly editedByAdmin: boolean;
}

/**
 * **Where a citation's verse text is read** ([3.3.4](docs/active-scope/prd.md)).
 *
 * A `GET` with the citation in the query, because that is what it is — a lookup of somebody else's
 * words by their reference. There is deliberately **no write here and nowhere else**: verse text is
 * what the source says ([3.3.8](docs/active-scope/prd.md)), so no route in the product accepts any,
 * and correcting a passage means correcting the citation.
 */
export const SCRIPTURE_PASSAGE_PATH = '/scripture/passage';

/** The lookup for one citation, relative to the `/api/v1` prefix. */
export function passagePath(citation: ScriptureCitation): string {
  const query = new URLSearchParams({
    book: citation.book,
    chapter: String(citation.chapter),
    verseStart: String(citation.verseStart),
    verseEnd: String(citation.verseEnd),
  });
  return `${SCRIPTURE_PASSAGE_PATH}?${query.toString()}`;
}

/**
 * Payload of `GET /api/v1/scripture/passage`.
 *
 * `null` is a real answer and the common one when a source is down: the citation stands and has no
 * text yet ([3.3.6](docs/active-scope/prd.md)). It is not an error, and a caller that treated it as
 * one would turn a missing convenience into a broken screen.
 */
export interface PassagePayload {
  readonly passage: string | null;
}
