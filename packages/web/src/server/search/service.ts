import { searchEmbeddings, type SearchHitRow } from '@thp/db';
import { EmbeddingError, embedder as configuredEmbedder, type Embedder } from '@thp/embed';
import {
  SEARCH_CANDIDATES_PER_ARM,
  SEARCH_PAGE_SIZE,
  SEARCH_RESULT_LIMIT,
  readSearchRequest,
  searchPath,
  type SearchHit,
  type SearchPayload,
  type SearchRequest,
} from '@thp/shared';
import { actorGuard } from '@/server/api/actor-limits';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { logger } from '@/server/observability/logger';
import { mintArtworkGrant } from '@/server/series/artwork-grant';
import { searchCache as sharedSearchCache, searchCacheKey, type SearchCache } from './cache';

/**
 * **One search, end to end** ([3.10](docs/project/prd.md)): the budget, the one provider call,
 * the fused query, and the rows as the page prints them.
 *
 * **Costs one provider call per search**, and that is the whole running cost of the feature: the
 * query text is embedded once ([3.10.2](docs/project/prd.md)), the vector is handed to the
 * database and discarded. The call is a fraction of a cent (`@thp/embed`'s adapter names the
 * price), and the budget in `actor-limits.ts` is spent *before* the call, because here the call is
 * what the budget guards. **At the "Words only" stop the call is not made at all**: the member
 * asked for no meaning, so no vector is bought and the query runs the word arm alone, exactly as
 * the degraded search does. A "Show more" page is a second request and a second call, under the
 * same budget.
 *
 * **A search already answered this week is answered from the cache** (`cache.ts`): the same
 * account asking the same address again gets the rows kept from the first time, re-signed, and
 * spends neither a provider call nor its budget — the budget guards the call, and a cached answer
 * makes none. The cache empties at the end of every Sunday, UTC, which is the operator's rule for
 * how stale a search may be; a note written on Wednesday is found by a search first asked on
 * Tuesday only once the week has turned, or once the words change.
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
 * is recorded is the length of the query, how many hits came back, which arms ran, how the
 * member weighed them and how long it took: enough to tune and to notice a provider outage,
 * nothing that says what was asked. The words go to the provider, as every note already does
 * (`.env.example`, `EMBED_PROVIDER`), and nowhere else.
 *
 * **The scores are an operator's.** Every hit carries its ranks, similarity and fused score, and
 * the payload says whether the actor may see them — `search.tune`, an admin's action — so the
 * thresholds in `@thp/shared` can be judged against the real library from the page itself.
 */

export interface SearchDependencies {
  /** The embedder to use; the process's configured one unless a test hands one in. */
  readonly embedder?: Embedder;
  /** The cache to read and write; the process's one unless a test hands one in. */
  readonly cache?: SearchCache;
}

export async function searchFor(
  actor: Actor,
  params: URLSearchParams,
  deps: SearchDependencies = {},
): Promise<SearchPayload> {
  const check = readSearchRequest(params);
  if (!check.ok) throw ApiError.invalidInput(check.problem);
  const request = check.request;

  // Asked before the budget is spent: a cached answer makes no call, and the call is the cost.
  const cache = deps.cache ?? sharedSearchCache();
  const cacheKey = searchCacheKey(actor.id, searchPath(request));
  const kept = cache.get(cacheKey);
  if (kept !== null) {
    logger.info('search.performed', {
      actorId: actor.id,
      action: 'search.query',
      target: 'library',
      queryLength: request.query.length,
      hits: Math.min(kept.rows.length, SEARCH_PAGE_SIZE),
      offset: request.offset,
      blend: request.blend,
      perTeaching: request.perTeaching,
      kinds: request.kinds,
      cached: true,
    });
    return describePage(actor, request, kept.rows, true);
  }

  // Spent on every accepted request, before the provider is asked: the call is the cost.
  actorGuard().spend('search', actor);

  const startedAt = performance.now();
  const wantsMeaning = request.blend > 0;
  const embedded = wantsMeaning
    ? await embedQuery(request.query, deps.embedder ?? configuredEmbedder(), actor)
    : { vector: null, available: true };
  const embeddedAt = performance.now();

  // One more than the page, so "is there another page" is answered by the same statement.
  const rows = await searchEmbeddings({
    readerId: actor.id,
    queryText: request.query,
    queryVector: embedded.vector,
    kinds: request.kinds,
    blend: request.blend,
    perTeaching: request.perTeaching,
    perArm: SEARCH_CANDIDATES_PER_ARM,
    offset: request.offset,
    limit: SEARCH_PAGE_SIZE + 1,
  });

  // A words-only answer the member did not ask for is not kept: the next ask tries the provider.
  if (embedded.available) cache.set(cacheKey, { rows });

  logger.info('search.performed', {
    actorId: actor.id,
    action: 'search.query',
    target: 'library',
    queryLength: request.query.length,
    hits: Math.min(rows.length, SEARCH_PAGE_SIZE),
    hasMore: hasAnotherPage(rows, request.offset),
    offset: request.offset,
    blend: request.blend,
    perTeaching: request.perTeaching,
    kinds: request.kinds,
    meaningAvailable: embedded.available,
    cached: false,
    embedMs: Math.round(embeddedAt - startedAt),
    queryMs: Math.round(performance.now() - embeddedAt),
  });

  return describePage(actor, request, rows, embedded.available);
}

function hasAnotherPage(rows: readonly SearchHitRow[], offset: number): boolean {
  return rows.length > SEARCH_PAGE_SIZE && offset + SEARCH_PAGE_SIZE < SEARCH_RESULT_LIMIT;
}

/** The payload for one page of rows — the same whether the rows were just found or kept. */
async function describePage(
  actor: Actor,
  request: SearchRequest,
  rows: readonly SearchHitRow[],
  meaningAvailable: boolean,
): Promise<SearchPayload> {
  const page = rows.slice(0, SEARCH_PAGE_SIZE);
  return {
    query: request.query,
    hits: await Promise.all(page.map(describeHit)),
    offset: request.offset,
    hasMore: hasAnotherPage(rows, request.offset),
    meaningAvailable,
    showScores: can(actor, 'search.tune'),
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
async function embedQuery(
  query: string,
  embedder: Embedder,
  actor: Actor,
): Promise<{ readonly vector: number[] | null; readonly available: boolean }> {
  try {
    const result = await embedder.embed([query]);
    const vector = result.vectors[0];
    if (vector === undefined) {
      throw new EmbeddingError('The embedding provider answered no vector for the query.');
    }
    return { vector: [...vector], available: true };
  } catch (cause) {
    if (!(cause instanceof EmbeddingError)) throw cause;
    logger.warn('search.embed-failed', {
      actorId: actor.id,
      action: 'search.query',
      target: 'library',
      reason: cause.message,
      provider: embedder.name,
    });
    return { vector: null, available: false };
  }
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
    passageMarked: row.textMarked,
    before: row.before,
    after: row.after,
    matchedBy,
    similarity: row.similarity,
    scores: {
      vectorRank: row.vectorRank,
      textRank: row.textRank,
      similarity: row.similarity,
      score: row.score,
    },
  };
}
