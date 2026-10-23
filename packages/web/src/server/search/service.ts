import {
  listCitedBooks,
  listTagsForRecordings,
  listTagsForSeries,
  listVisibleRecordings,
  searchEmbeddings,
  type SearchHitRow,
} from '@thp/db';
import { EmbeddingError, embedder as configuredEmbedder, type Embedder } from '@thp/embed';
import {
  BIBLE_BOOKS,
  SEARCH_CANDIDATES_PER_ARM,
  SEARCH_RESULT_LIMIT,
  readSearchRequest,
  type SearchFiltersPayload,
  type SearchHit,
  type SearchPayload,
  type SearchRequest,
  type TagRef,
} from '@thp/shared';
import { actorGuard } from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';

/**
 * **One search, end to end** ([3.10](docs/project/prd.md)): the budget, the one provider call,
 * the fused query, and the rows as the page prints them.
 *
 * **Costs one provider call per search**, and that is the whole running cost of the feature: the
 * query text is embedded once ([3.10.2](docs/project/prd.md)), the vector is handed to the
 * database and discarded. Nothing is cached — two members typing the same words is rare and the
 * call is a fraction of a cent (`@thp/embed`'s adapter names the price) — and the budget in
 * `actor-limits.ts` is spent *before* the call, because here the call is what the budget guards.
 *
 * **The provider failing degrades the search; the database failing fails it**
 * ([3.10.11](docs/project/prd.md)). The operator chose words-only results over no results: an
 * `EmbeddingError` — a timeout, a refusal, an unreachable host — is caught, logged, and the query
 * runs with no vector, with `meaningAvailable: false` on the payload so the page can say what it
 * is showing. Anything the database throws is left to the route, which answers a `500` the page
 * renders as "search is unavailable". The two states are different on the wire because they are
 * different to a member: one has results that may be missing the best ones, the other has none.
 *
 * **Nothing a member typed is logged.** A search is a private act — the word a member is
 * struggling with, the passage they are looking for — and the log is read by an operator. What
 * is recorded is the length of the query, how many hits came back, which arms ran and how long
 * it took: enough to tune and to notice a provider outage, nothing that says what was asked. The
 * words go to the provider, as every note already does (`.env.example`, `EMBED_PROVIDER`), and
 * nowhere else.
 */

export interface SearchDependencies {
  /** The embedder to use; the process's configured one unless a test hands one in. */
  readonly embedder?: Embedder;
}

/** Hits per search. Named here so the route and a test agree without reading the shared constant twice. */
export const RESULT_LIMIT = SEARCH_RESULT_LIMIT;

export async function searchFor(
  actor: Actor,
  params: URLSearchParams,
  deps: SearchDependencies = {},
): Promise<SearchPayload> {
  const check = readSearchRequest(params);
  if (!check.ok) throw ApiError.invalidInput(check.problem);
  const request = check.request;

  // Spent on every accepted request, before the provider is asked: the call is the cost.
  actorGuard().spend('search', actor);

  const startedAt = performance.now();
  const queryVector = await embedQuery(request.query, deps.embedder ?? configuredEmbedder(), actor);
  const embeddedAt = performance.now();

  const rows = await searchEmbeddings({
    readerId: actor.id,
    queryText: request.query,
    queryVector,
    filters: {
      seriesId: request.seriesId,
      recordedFrom: request.recordedFrom,
      recordedTo: request.recordedTo,
      tagId: request.tagId,
      book: request.book,
      onlyMine: request.onlyMine,
    },
    perArm: SEARCH_CANDIDATES_PER_ARM,
    limit: RESULT_LIMIT,
  });

  logger.info('search.performed', {
    actorId: actor.id,
    action: 'search.query',
    target: 'library',
    queryLength: request.query.length,
    hits: rows.length,
    meaningAvailable: queryVector !== null,
    filtered: describeFilters(request),
    embedMs: Math.round(embeddedAt - startedAt),
    queryMs: Math.round(performance.now() - embeddedAt),
  });

  return {
    query: request.query,
    hits: await Promise.all(rows.map(describeHit)),
    meaningAvailable: queryVector !== null,
  };
}

/**
 * The query as a vector, or `null` when the provider could not answer.
 *
 * Only an {@link EmbeddingError} is caught — that is the adapter's word for "the provider, not
 * us", covering a timeout, a refusal and an unreachable host. Anything else is a bug in this
 * process and is left to become a `500`, because hiding it behind words-only results would hide
 * it from the operator too.
 */
async function embedQuery(query: string, embedder: Embedder, actor: Actor): Promise<number[] | null> {
  try {
    const result = await embedder.embed([query]);
    const vector = result.vectors[0];
    if (vector === undefined) {
      throw new EmbeddingError('The embedding provider answered no vector for the query.');
    }
    return [...vector];
  } catch (cause) {
    if (!(cause instanceof EmbeddingError)) throw cause;
    logger.warn('search.embed-failed', {
      actorId: actor.id,
      action: 'search.query',
      target: 'library',
      reason: cause.message,
      provider: embedder.name,
    });
    return null;
  }
}

/** Which filters were on, as names — never their values, which could name a member's interest. */
function describeFilters(request: SearchRequest): string[] {
  const on: string[] = [];
  if (request.seriesId !== null) on.push('series');
  if (request.recordedFrom !== null || request.recordedTo !== null) on.push('date');
  if (request.tagId !== null) on.push('tag');
  if (request.book !== null) on.push('book');
  if (request.onlyMine) on.push('mine');
  return on;
}

/**
 * One row as the page prints it. Async for the cover: the series ref carries a signed URL rather
 * than a key, exactly as the recording payload's does, so a hit opened into the transport shows
 * the same tile the recording page would.
 */
async function describeHit(row: SearchHitRow): Promise<SearchHit> {
  const matchedBy: ('meaning' | 'words')[] = [];
  if (row.vectorRank !== null) matchedBy.push('meaning');
  if (row.textRank !== null) matchedBy.push('words');
  return {
    id: row.embeddingId,
    kind: row.sourceKind,
    sourceId: row.sourceId,
    recording: {
      id: row.recordingId,
      title: row.recordingTitle,
      recordedAt: row.recordedAt,
      series:
        row.seriesId === null || row.seriesTitle === null
          ? null
          : {
              id: row.seriesId,
              title: row.seriesTitle,
              artworkUrl: await mintArtworkGrant(row.seriesArtworkKey),
            },
    },
    startMs: row.startMs,
    passage: row.text,
    before: row.before,
    after: row.after,
    matchedBy,
  };
}

/**
 * What there is to narrow by ([3.10.8](docs/project/prd.md)): the series, tags and books of the
 * teachings this member may see — the member's view whatever the caller's role, because the
 * results the filters narrow are the member's view too.
 *
 * Three reads over the ids the visibility read allowed, rather than one query with a publication
 * predicate: which teachings are visible is `visibility.ts`'s one answer, and these are narrowings
 * of it. Tags are the union of each recording's and its series', which is the set the tag filter
 * in the query matches against.
 */
export async function searchFiltersFor(actor: Actor): Promise<SearchFiltersPayload> {
  const visible = await listVisibleRecordings({ includeUnpublished: false });
  const recordingIds = visible.map((row) => row.id);
  const seriesIds = [...new Set(visible.flatMap((row) => (row.seriesId === null ? [] : [row.seriesId])))];

  const [recordingTags, seriesTags, books] = await Promise.all([
    listTagsForRecordings(recordingIds),
    listTagsForSeries(seriesIds),
    listCitedBooks(recordingIds),
  ]);
  const cited = new Set(books);

  const tags = new Map<string, TagRef>();
  for (const list of [...recordingTags.values(), ...seriesTags.values()]) {
    for (const tag of list) tags.set(tag.id, { id: tag.id, name: tag.name });
  }

  const series = new Map<string, string>();
  for (const row of visible) {
    if (row.seriesId !== null && row.seriesTitle !== null) series.set(row.seriesId, row.seriesTitle);
  }

  logger.info('search.filters', {
    actorId: actor.id,
    action: 'search.query',
    target: 'library',
    series: series.size,
    tags: tags.size,
    books: books.length,
  });

  return {
    series: [...series.entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // Walked in canon order, which is the order a reader expects a list of books in, and dropping
    // any stored identity the canon does not know — there should be none, and a filter offering one
    // would be refused by the request parser anyway.
    books: BIBLE_BOOKS.filter((book) => cited.has(book.id)).map((book) => ({
      id: book.id,
      name: book.name,
    })),
  };
}
