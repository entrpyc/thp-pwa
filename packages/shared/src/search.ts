import type { EmbeddingSourceKind } from './embeddings';
import type { RecordingSeriesRef } from './recordings';

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
 * - **The address is the query.** `?q=` and every control live in the URL, so a search survives a
 *   reload, can be shared, and the back button returns to the results rather than to an empty box.
 *   A control at its default is **left out of the address**, so links stay short and a later change
 *   of default applies to old links.
 * - **Five kinds of hit, not six.** The embed step writes passage windows (`segment`), chapters,
 *   notes, the published summary and one `recording` row per teaching carrying its title,
 *   description, series title and the summary's opening; all five are searched
 *   ([3.10.4](docs/project/prd.md)) and a member may narrow to any subset of them
 *   ({@link SEARCH_PARAMS.kinds}). Tags and scripture citations are not embedded; a citation is
 *   still found wherever a transcript *says* it ([3.10.5](docs/project/prd.md)), which the
 *   full-text arm is for.
 * - **The controls are about the ranking, not the library.** The series, tag, book, date and
 *   "only my notes" filters of [3.10.8](docs/project/prd.md) and [3.10.10](docs/project/prd.md)
 *   were built and withdrawn by the operator. What a member steers instead is *how* the two arms
 *   are weighed ({@link SEARCH_BLEND_STOPS}), how many moments of one teaching may fill the page
 *   ({@link SEARCH_PER_TEACHING_OPTIONS}), and which kinds of thing are searched.
 * - **How a match is explained.** Every hit says which arms placed it. A meaning hit is labelled
 *   by its cosine similarity, bucketed by {@link SIMILARITY_STRONG_MATCH} and
 *   {@link SIMILARITY_GOOD_MATCH}; the number itself is shown to nobody but an operator, in a
 *   disclosure the payload's `showScores` opens. A words hit has its matched terms marked in the
 *   passage with {@link SEARCH_MARK_START} and {@link SEARCH_MARK_END} — characters, not HTML, so
 *   the page splits and the markup is its own.
 */

/** `GET /api/v1/search?q=…` — the fused query. */
export const SEARCH_PATH = '/search';

/** The results page, on the web origin. */
export const SEARCH_PAGE_PATH = '/search';

/** The query parameters, named once so the box, the page and the route cannot spell them apart. */
export const SEARCH_PARAMS = {
  query: 'q',
  /** A comma-separated subset of {@link SEARCHABLE_KINDS}. Absent, or all of them, is everything. */
  kinds: 'kinds',
  /** One of {@link SEARCH_BLEND_STOPS}: how much the meaning arm weighs against the words arm. */
  blend: 'mix',
  /** `1`, `3` or `all`: how many moments of one teaching may be answered. */
  perTeaching: 'per',
  /** How many fused rows to skip — the page asks for the next ten by passing what it already has. */
  offset: 'offset',
} as const;

/**
 * The longest query accepted. A sentence or two is a search; a pasted paragraph is a document,
 * and embedding one per keypress of a stuck key is the flood the budget below also guards.
 */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * Hits per page: ten, which a member reads to the end on a phone. "Show more" asks for the next
 * ten by offset, up to {@link SEARCH_RESULT_LIMIT}.
 */
export const SEARCH_PAGE_SIZE = 10;

/**
 * The most hits one search can reach by paging: fifty. Beyond that the member is browsing a
 * ranking's tail, and a better query is the answer. {@link SEARCH_CANDIDATES_PER_ARM} is what
 * makes fifty fused rows reachable at all.
 */
export const SEARCH_RESULT_LIMIT = 50;

/**
 * Candidates taken from each index before the two rankings are fused (project tdd 4.5).
 *
 * A hundred, up from forty: the fusion rewards a row *both* arms placed, and with forty per arm
 * over a library of passage windows the two sets rarely overlapped at all — fusion then only
 * interleaved two independent lists, and the "found by words *and* meaning" signal it exists for
 * never fired. A hundred is still one index probe per arm and well inside what the HNSW index
 * answers in a few milliseconds.
 */
export const SEARCH_CANDIDATES_PER_ARM = 100;

/**
 * Searches one account may run in an hour. Sixty is one a minute for an hour straight, which is
 * more than a person reading results between searches ever reaches; the sixty-first is a script,
 * and each one would be a provider call. A constant rather than configuration, like the other
 * per-account budgets (`server/api/actor-limits.ts`).
 */
export const SEARCH_BUDGET_PER_HOUR = 60;

/**
 * The kinds a search ranks: passage windows, chapters, notes, the published summary and the
 * recording's own row (title, description, series, the summary's opening).
 *
 * **`series` is not among them, and not for this round.** Nothing in search can return a row
 * without a recording id — every hit is a teaching to open, and the visibility rule gates on the
 * recording's publication — and a series hit would need a destination of its own (the series
 * page), a gate of its own (a series is visible when it holds a published teaching) and a result
 * row that is not a teaching. The embed step writes no series row either, so admitting the kind
 * here would admit nothing. When series are embedded, they join this list together with that
 * read-back and that gate.
 */
export const SEARCHABLE_KINDS = [
  'segment',
  'chapter',
  'note',
  'summary',
  'recording',
] as const satisfies readonly EmbeddingSourceKind[];

export type SearchableKind = (typeof SEARCHABLE_KINDS)[number];

export function isSearchableKind(value: unknown): value is SearchableKind {
  return typeof value === 'string' && (SEARCHABLE_KINDS as readonly string[]).includes(value);
}

/** What each kind is called on the content-type control. "Transcript" rather than "segment": a member never sees the word. */
export const SEARCH_KIND_LABELS: Record<SearchableKind, string> = {
  chapter: 'Chapters',
  segment: 'Transcript',
  note: 'Notes',
  summary: 'Summaries',
  recording: 'Teachings',
};

/** The order the content-type checkboxes are drawn in. */
export const SEARCH_KIND_ORDER: readonly SearchableKind[] = [
  'chapter',
  'segment',
  'note',
  'summary',
  'recording',
];

/**
 * **The words/meaning slider's stops.** The fusion is
 * `s / (K + vector_rank) + (1 - s) / (K + text_rank)` with `s` the stop: at `0` the provider is not
 * called and the meaning arm does not run; at `1` the words arm does not run. Five snapped stops
 * rather than a continuous value because a member cannot tell 0.6 from 0.7, and because five
 * labelled positions are five things a tester can name.
 */
export const SEARCH_BLEND_STOPS = [0, 0.25, 0.5, 0.75, 1] as const;

export type SearchBlend = (typeof SEARCH_BLEND_STOPS)[number];

export const SEARCH_BLEND_LABELS: Readonly<Record<SearchBlend, string>> = {
  0: 'Words only',
  0.25: 'Lean words',
  0.5: 'Balanced',
  0.75: 'Lean meaning',
  1: 'Meaning only',
};

/** Balanced: the two arms weigh the same, which is the fusion as it was published. */
export const SEARCH_DEFAULT_BLEND: SearchBlend = 0.5;

export function isSearchBlend(value: unknown): value is SearchBlend {
  return typeof value === 'number' && (SEARCH_BLEND_STOPS as readonly number[]).includes(value);
}

/**
 * **How many moments of one teaching the page may show**: one, three, or every one. `null` is
 * "every moment". Applied in SQL after fusion and before the page limit, so a long teaching that
 * says the words in forty passages does not fill the page with itself and the page still fills.
 */
export type SearchPerTeaching = 1 | 3 | null;

export const SEARCH_PER_TEACHING_OPTIONS: readonly {
  readonly value: SearchPerTeaching;
  /** How the value is spelled in the address. */
  readonly param: string;
  readonly label: string;
}[] = [
  { value: 1, param: '1', label: 'One moment per teaching' },
  { value: 3, param: '3', label: 'Up to three per teaching' },
  { value: null, param: 'all', label: 'Every moment' },
];

export const SEARCH_DEFAULT_PER_TEACHING: SearchPerTeaching = 3;

/**
 * **How a meaning hit is labelled**, by its cosine similarity to the query. Starting values, to be
 * tuned against the real library from the operator's score disclosure: for
 * `text-embedding-3-small` two passages on one theme sit near 0.5 and a near-paraphrase above
 * 0.55. The number itself is never shown to a member.
 */
export const SIMILARITY_STRONG_MATCH = 0.55;
export const SIMILARITY_GOOD_MATCH = 0.4;

export const MEANING_LABELS = {
  strong: 'Meaning: Strong match',
  good: 'Meaning: Good match',
  related: 'Meaning: Related',
} as const;

export function meaningLabel(similarity: number): string {
  if (similarity >= SIMILARITY_STRONG_MATCH) return MEANING_LABELS.strong;
  if (similarity >= SIMILARITY_GOOD_MATCH) return MEANING_LABELS.good;
  return MEANING_LABELS.related;
}

/** The one label a words hit carries. */
export const WORDS_MATCH_LABEL = 'Words: Matched';

/**
 * **The markers around a matched term** in `passageMarked`. Characters a transcript never
 * contains rather than HTML: the database wraps terms in them, the page splits on them, and
 * nothing anywhere trusts a string as markup.
 */
export const SEARCH_MARK_START = '⟦';
export const SEARCH_MARK_END = '⟧';

/** One run of a marked passage: the text and whether it is a matched term. */
export interface PassageRun {
  readonly text: string;
  readonly matched: boolean;
}

/**
 * Split a marked passage into runs. Markers that do not pair — a start with no end — are read as
 * plain text rather than refused: the passage is still a passage.
 */
export function splitMarkedPassage(marked: string): PassageRun[] {
  const runs: PassageRun[] = [];
  let rest = marked;
  for (;;) {
    const start = rest.indexOf(SEARCH_MARK_START);
    if (start === -1) break;
    const end = rest.indexOf(SEARCH_MARK_END, start + 1);
    if (end === -1) break;
    if (start > 0) runs.push({ text: rest.slice(0, start), matched: false });
    runs.push({ text: rest.slice(start + 1, end), matched: true });
    rest = rest.slice(end + 1);
  }
  if (rest !== '') runs.push({ text: rest, matched: false });
  return runs;
}

/** What one search asks for, after the address has been read and refused or accepted whole. */
export interface SearchRequest {
  readonly query: string;
  /** Which kinds are searched. Never empty: an empty or absent choice is every kind. */
  readonly kinds: readonly SearchableKind[];
  readonly blend: SearchBlend;
  readonly perTeaching: SearchPerTeaching;
  /** Fused rows to skip. A multiple of the page size, under the result limit. */
  readonly offset: number;
}

export type SearchRequestCheck =
  | { readonly ok: true; readonly request: SearchRequest }
  | { readonly ok: false; readonly problem: string };

/** The request every address starts from: every kind, balanced, three per teaching, the first page. */
export const DEFAULT_SEARCH_REQUEST: Omit<SearchRequest, 'query'> = {
  kinds: SEARCHABLE_KINDS,
  blend: SEARCH_DEFAULT_BLEND,
  perTeaching: SEARCH_DEFAULT_PER_TEACHING,
  offset: 0,
};

/**
 * Read a search out of its address.
 *
 * Refuses rather than ignores a control it cannot read: a mistyped kind that was silently dropped
 * would answer the whole library under a heading that said it was narrowed, and the member would
 * have no way to tell. The empty query is refused here too, before any call is spent on it — the
 * page shows its own prompt for an empty box and never asks. An absent control is its default.
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

  const kindsParam = optional(params, SEARCH_PARAMS.kinds);
  let kinds: readonly SearchableKind[] = SEARCHABLE_KINDS;
  if (kindsParam !== null) {
    const named = kindsParam
      .split(',')
      .map((one) => one.trim())
      .filter((one) => one !== '');
    if (!named.every(isSearchableKind)) {
      return { ok: false, problem: 'The content types are not ones a search knows.' };
    }
    const chosen = new Set<SearchableKind>(named);
    // Nothing ticked, or everything, is everything.
    kinds =
      chosen.size === 0 || chosen.size === SEARCHABLE_KINDS.length
        ? SEARCHABLE_KINDS
        : SEARCHABLE_KINDS.filter((kind) => chosen.has(kind));
  }

  const blendParam = optional(params, SEARCH_PARAMS.blend);
  let blend: SearchBlend = SEARCH_DEFAULT_BLEND;
  if (blendParam !== null) {
    const value = Number(blendParam);
    if (!isSearchBlend(value)) {
      return { ok: false, problem: 'The words/meaning setting is not one of the slider’s stops.' };
    }
    blend = value;
  }

  const perParam = optional(params, SEARCH_PARAMS.perTeaching);
  let perTeaching: SearchPerTeaching = SEARCH_DEFAULT_PER_TEACHING;
  if (perParam !== null) {
    const option = SEARCH_PER_TEACHING_OPTIONS.find((one) => one.param === perParam);
    if (option === undefined) {
      return { ok: false, problem: 'The per-teaching setting is not one a search knows.' };
    }
    perTeaching = option.value;
  }

  const offsetParam = optional(params, SEARCH_PARAMS.offset);
  let offset = 0;
  if (offsetParam !== null) {
    const value = Number(offsetParam);
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value % SEARCH_PAGE_SIZE !== 0 ||
      value > SEARCH_RESULT_LIMIT - SEARCH_PAGE_SIZE
    ) {
      return { ok: false, problem: 'The page offset is not one a search can answer.' };
    }
    offset = value;
  }

  return { ok: true, request: { query, kinds, blend, perTeaching, offset } };
}

function optional(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)?.trim() ?? '';
  return value === '' ? null : value;
}

/**
 * The results page for this search — the address the navigation's box goes to on Enter. A control
 * at its default is left out, so the address says only what the member changed.
 */
export function searchPagePath(request: Partial<SearchRequest> & { readonly query: string }): string {
  const params = new URLSearchParams();
  params.set(SEARCH_PARAMS.query, request.query);
  const kinds = request.kinds ?? SEARCHABLE_KINDS;
  if (kinds.length > 0 && kinds.length < SEARCHABLE_KINDS.length) {
    params.set(SEARCH_PARAMS.kinds, SEARCHABLE_KINDS.filter((kind) => kinds.includes(kind)).join(','));
  }
  const blend = request.blend ?? SEARCH_DEFAULT_BLEND;
  if (blend !== SEARCH_DEFAULT_BLEND) params.set(SEARCH_PARAMS.blend, String(blend));
  const perTeaching = request.perTeaching === undefined ? SEARCH_DEFAULT_PER_TEACHING : request.perTeaching;
  if (perTeaching !== SEARCH_DEFAULT_PER_TEACHING) {
    const option = SEARCH_PER_TEACHING_OPTIONS.find((one) => one.value === perTeaching);
    if (option !== undefined) params.set(SEARCH_PARAMS.perTeaching, option.param);
  }
  if ((request.offset ?? 0) > 0) params.set(SEARCH_PARAMS.offset, String(request.offset));
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
 * **The raw numbers behind a hit**, for the operator tuning the thresholds. Carried on every hit;
 * drawn only when the payload's `showScores` says the actor is an admin.
 */
export interface SearchHitScores {
  /** Position in the meaning arm's ranking, or `null` when that arm did not place the row. */
  readonly vectorRank: number | null;
  /** Position in the words arm's ranking, or `null`. */
  readonly textRank: number | null;
  /** Cosine similarity to the query, `1 - distance`; `null` when the meaning arm did not place the row. */
  readonly similarity: number | null;
  /** The fused score the page is ordered by. */
  readonly score: number;
}

/**
 * One result ([3.10.3](docs/project/prd.md), [3.10.6](docs/project/prd.md)).
 *
 * `startMs` is where the member lands: a passage window's first non-filler sentence, a chapter's
 * start, or the moment a note was written against — `null` for a note on the teaching as a whole
 * and for a `recording` or `summary` hit, which open the recording where the member last left it.
 * `kind` is what the row *is*, and it decides where selecting the row goes
 * ([3.10.7](docs/project/prd.md)): a chapter opens its page, everything else opens the recording
 * at `startMs` without playing ([3.2.12](docs/project/prd.md)).
 *
 * `passage` is the matched text whole; `passageMarked` is the same text with every matched term
 * wrapped in {@link SEARCH_MARK_START} and {@link SEARCH_MARK_END} when the words arm placed the
 * row, and identical to `passage` otherwise. `before` and `after` are the transcript lines either
 * side of a window — never marked, never inside the passage; `null` on every other kind.
 */
export interface SearchHit {
  /** The embedding row's id — stable for a key, meaningless to a member. */
  readonly id: string;
  readonly kind: SearchableKind;
  readonly sourceId: string;
  readonly recording: SearchHitRecording;
  readonly startMs: number | null;
  readonly passage: string;
  readonly passageMarked: string;
  readonly before: string | null;
  readonly after: string | null;
  /** Which arms placed this row: both is the strongest kind of hit. */
  readonly matchedBy: readonly ('meaning' | 'words')[];
  /** Cosine similarity for a meaning hit, `null` otherwise. What {@link meaningLabel} buckets. */
  readonly similarity: number | null;
  readonly scores: SearchHitScores;
}

/** Payload of `GET /api/v1/search`. */
export interface SearchPayload {
  readonly query: string;
  /** This page's hits: at most {@link SEARCH_PAGE_SIZE}. */
  readonly hits: readonly SearchHit[];
  /** The offset these hits start at. */
  readonly offset: number;
  /** Whether asking again at `offset + hits.length` would answer more, within {@link SEARCH_RESULT_LIMIT}. */
  readonly hasMore: boolean;
  /**
   * Whether the meaning arm ran ([3.10.11](docs/project/prd.md)). `false` when the embedding
   * provider failed or timed out and the hits are words-only — the page says so, because a member
   * who searched for a concept and got nothing deserves to know the half that would have found it
   * was not consulted. A search at the "Words only" stop asked for no meaning and is `true`. A
   * database failure is not this: that is the route failing outright, and the page's "search is
   * unavailable" state.
   */
  readonly meaningAvailable: boolean;
  /** Whether the actor may see the raw scores: an admin tuning the thresholds, nobody else. */
  readonly showScores: boolean;
}
