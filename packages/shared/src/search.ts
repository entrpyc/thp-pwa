import type { EmbeddingSourceKind } from './embeddings';
import type { RecordingSeriesRef } from './recordings';
import { findBook } from './scripture';
import type { TagRef } from './tags';

/**
 * **Semantic search** ([3.10](docs/project/prd.md)) — the vocabulary the box in the navigation,
 * the results page and `GET /api/v1/search` share.
 *
 * What is decided here and nowhere else:
 *
 * - **One query, on Enter.** The operator chose a submitted search over one that runs as the
 *   member types: every search embeds its text with the provider ([3.10.2](docs/project/prd.md)),
 *   which is one paid call per query, and a box that searched on every pause would spend one per
 *   pause. So the navigation's box *navigates* — to {@link searchPagePath} — and the results page
 *   is the one caller of the route. {@link SEARCH_BUDGET_PER_HOUR} is the ceiling on that.
 * - **The address is the query.** `?q=` and every filter live in the URL, so a search survives a
 *   reload, can be shared, and the back button returns to the results rather than to an empty box.
 * - **Three kinds of hit, not five.** The embed step writes segments, chapters, notes and the
 *   published summary; the operator chose to leave the summary out of search for this round, and
 *   a series row is never written at all. {@link SEARCHABLE_KINDS} is that decision, read by the
 *   query. Recording titles, descriptions, tags, series titles and scripture citations are not
 *   embedded and so are not searched yet — [3.10.4](docs/project/prd.md) names them and this
 *   round covers the rows that exist; a citation is still found wherever a transcript *says* it
 *   ([3.10.5](docs/project/prd.md)), which the full-text arm is for.
 * - **Personal mind maps do not exist yet** ([3.8](docs/project/prd.md)), so the "only my notes"
 *   restriction of [3.10.10](docs/project/prd.md) is notes alone. When mind maps arrive they join
 *   {@link SEARCHABLE_KINDS}, the `onlyMine` predicate in `packages/db/src/search.ts` gains a
 *   second author join, and nothing on the wire changes — `mine` already means "what I wrote".
 */

/** `GET /api/v1/search?q=…` — the fused query. */
export const SEARCH_PATH = '/search';

/** `GET /api/v1/search/filters` — what a member may narrow by: the series, tags and books in view. */
export const SEARCH_FILTERS_PATH = `${SEARCH_PATH}/filters`;

/** The results page, on the web origin. */
export const SEARCH_PAGE_PATH = '/search';

/** The query parameters, named once so the box, the page and the route cannot spell them apart. */
export const SEARCH_PARAMS = {
  query: 'q',
  series: 'series',
  from: 'from',
  to: 'to',
  tag: 'tag',
  book: 'book',
  /** `1` restricts the search to notes the member wrote ([3.10.10](docs/project/prd.md)). */
  mine: 'mine',
} as const;

/**
 * The longest query accepted. A sentence or two is a search; a pasted paragraph is a document,
 * and embedding one per keypress of a stuck key is the flood the budget below also guards.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * How many hits one search answers. Twenty is a page a member reads to the end on a phone; the
 * fusion behind it reads {@link SEARCH_CANDIDATES_PER_ARM} from each index, so a hit the vector
 * arm placed thirtieth and the word arm placed first still arrives.
 */
export const SEARCH_RESULT_LIMIT = 20;

/** Candidates taken from each index before the two rankings are fused (project tdd 4.5). */
export const SEARCH_CANDIDATES_PER_ARM = 40;

/**
 * Searches one account may run in an hour. Sixty is one a minute for an hour straight, which is
 * more than a person reading results between searches ever reaches; the sixty-first is a script,
 * and each one would be a provider call. A constant rather than configuration, like the other
 * per-account budgets (`server/api/actor-limits.ts`).
 */
export const SEARCH_BUDGET_PER_HOUR = 60;

/** The kinds a search ranks. See the module comment for why the summary is not among them. */
export const SEARCHABLE_KINDS = ['segment', 'chapter', 'note'] as const satisfies readonly EmbeddingSourceKind[];

export type SearchableKind = (typeof SEARCHABLE_KINDS)[number];

/** A `YYYY-MM-DD` the date filters accept — the same spelling `recorded_at` is written in. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What one search asks for, after the address has been read and refused or accepted whole. */
export interface SearchRequest {
  readonly query: string;
  readonly seriesId: string | null;
  /** Inclusive, `YYYY-MM-DD`. */
  readonly recordedFrom: string | null;
  readonly recordedTo: string | null;
  readonly tagId: string | null;
  /** A book identity from `BIBLE_BOOKS`, never a name a member typed. */
  readonly book: string | null;
  readonly onlyMine: boolean;
}

export type SearchRequestCheck =
  | { readonly ok: true; readonly request: SearchRequest }
  | { readonly ok: false; readonly problem: string };

/**
 * Read a search out of its address.
 *
 * Refuses rather than ignores a filter it cannot read: a mistyped series id that was silently
 * dropped would answer the whole library under a heading that said it was one series, and the
 * member would have no way to tell. The empty query is refused here too, before any call is
 * spent on it — the page shows its own prompt for an empty box and never asks.
 */
export function readSearchRequest(params: URLSearchParams): SearchRequestCheck {
  const query = (params.get(SEARCH_PARAMS.query) ?? '').trim().replace(/\s+/g, ' ');
  if (query === '') return { ok: false, problem: 'Type something to search for.' };
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    return {
      ok: false,
      problem: `A search is at most ${MAX_SEARCH_QUERY_LENGTH} characters.`,
    };
  }

  const seriesId = optional(params, SEARCH_PARAMS.series);
  if (seriesId !== null && !UUID.test(seriesId)) {
    return { ok: false, problem: 'The series filter is not a series.' };
  }
  const tagId = optional(params, SEARCH_PARAMS.tag);
  if (tagId !== null && !UUID.test(tagId)) {
    return { ok: false, problem: 'The tag filter is not a tag.' };
  }
  const recordedFrom = optional(params, SEARCH_PARAMS.from);
  const recordedTo = optional(params, SEARCH_PARAMS.to);
  for (const day of [recordedFrom, recordedTo]) {
    if (day !== null && !DAY.test(day)) {
      return { ok: false, problem: 'A date filter is written as YYYY-MM-DD.' };
    }
  }
  if (recordedFrom !== null && recordedTo !== null && recordedFrom > recordedTo) {
    return { ok: false, problem: 'The date range ends before it starts.' };
  }
  const book = optional(params, SEARCH_PARAMS.book);
  if (book !== null && findBook(book) === null) {
    return { ok: false, problem: 'The book filter is not a book of the Bible.' };
  }
  const mine = optional(params, SEARCH_PARAMS.mine);

  return {
    ok: true,
    request: {
      query,
      seriesId,
      recordedFrom,
      recordedTo,
      tagId,
      book,
      onlyMine: mine === '1' || mine === 'true',
    },
  };
}

function optional(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim() ?? '';
  return value === '' ? null : value;
}

/** The results page for this search — the address the navigation's box goes to on Enter. */
export function searchPagePath(request: Partial<SearchRequest> & { readonly query: string }): string {
  const params = new URLSearchParams();
  params.set(SEARCH_PARAMS.query, request.query);
  if (request.seriesId) params.set(SEARCH_PARAMS.series, request.seriesId);
  if (request.recordedFrom) params.set(SEARCH_PARAMS.from, request.recordedFrom);
  if (request.recordedTo) params.set(SEARCH_PARAMS.to, request.recordedTo);
  if (request.tagId) params.set(SEARCH_PARAMS.tag, request.tagId);
  if (request.book) params.set(SEARCH_PARAMS.book, request.book);
  if (request.onlyMine) params.set(SEARCH_PARAMS.mine, '1');
  return `${SEARCH_PAGE_PATH}?${params.toString()}`;
}

/** The API route for the same search; the same parameters, so one function writes both. */
export function searchPath(request: Partial<SearchRequest> & { readonly query: string }): string {
  return `${SEARCH_PATH}${searchPagePath(request).slice(SEARCH_PAGE_PATH.length)}`;
}

/** The teaching a hit belongs to, as much of it as a result row prints ([3.10.6](docs/project/prd.md)). */
export interface SearchHitRecording {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly series: RecordingSeriesRef | null;
}

/**
 * One result ([3.10.3](docs/project/prd.md), [3.10.6](docs/project/prd.md)).
 *
 * `startMs` is where the member lands: a segment's start, a chapter's start, or the moment a note
 * was written against — `null` for a note on the teaching as a whole, which opens the recording
 * where the member last left it. `kind` is what the row *is*, and it decides where selecting the
 * row goes ([3.10.7](docs/project/prd.md)): a chapter opens its page, everything else opens the
 * recording at `startMs` without playing ([3.2.12](docs/project/prd.md)).
 *
 * `passage` is the matched text whole — a transcript line, a chapter's title and summary, a note.
 * `before` and `after` are the neighbouring transcript lines when the hit is a segment, so a
 * sentence reads in its context rather than as a fragment; `null` on every other kind, whose
 * passage is already the whole of what was written.
 */
export interface SearchHit {
  /** The embedding row's id — stable for a key, meaningless to a member. */
  readonly id: string;
  readonly kind: SearchableKind;
  readonly sourceId: string;
  readonly recording: SearchHitRecording;
  readonly startMs: number | null;
  readonly passage: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Which arms placed this row: both is the strongest kind of hit. For a tester, not a member. */
  readonly matchedBy: readonly ('meaning' | 'words')[];
}

/** Payload of `GET /api/v1/search`. */
export interface SearchPayload {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /**
   * Whether the meaning arm ran ([3.10.11](docs/project/prd.md)). `false` when the embedding
   * provider failed or timed out and the hits are words-only — the page says so, because a member
   * who searched for a concept and got nothing deserves to know the half that would have found it
   * was not consulted. A database failure is not this: that is the route failing outright, and the
   * page's "search is unavailable" state.
   */
  readonly meaningAvailable: boolean;
}

/** One series a member may narrow by. */
export interface SearchSeriesOption {
  readonly id: string;
  readonly title: string;
}

/** One book a member may narrow by: the identity the filter sends and the name it shows. */
export interface SearchBookOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Payload of `GET /api/v1/search/filters` ([3.10.8](docs/project/prd.md)) — what is *there* to
 * narrow by, computed from the published library rather than from the whole taxonomy, so a member
 * is never offered a tag or a book that no visible teaching carries.
 */
export interface SearchFiltersPayload {
  readonly series: readonly SearchSeriesOption[];
  readonly tags: readonly TagRef[];
  readonly books: readonly SearchBookOption[];
}
