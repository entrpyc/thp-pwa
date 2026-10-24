import { sql } from 'drizzle-orm';
import {
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  type SearchBlend,
  type SearchPerTeaching,
  type SearchableKind,
} from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import { chapter, embedding, note, recording, segment, series } from './schema';
import { embeddingVisibleTo } from './visibility';

/**
 * **The search query** ([3.10](docs/project/prd.md); project tdd 4.5) — the one `<=>` in the
 * repository, and the fusion around it, which `embeddings.ts` deliberately left to the caller
 * that would know what it was for.
 *
 * One statement, in five steps, and the order of the steps is the design:
 *
 * 1. **Visibility and the kinds first, inside each arm.** [3.10.9](docs/project/prd.md) is applied
 *    as `embeddingVisibleTo` *before* either `limit`, together with the kinds the member asked
 *    for. Filtering after a top-k is what breaks top-k — a member whose hundred nearest rows were
 *    all somebody else's private notes would get nothing — and keeping the vectors beside the
 *    permission rows so this could be a `where` is the whole of project tdd 4.4. The predicate is
 *    imported, never restated: `tests/guards/visibility-boundary` refuses a second spelling. The
 *    series, tag, book, date and "only mine" filters were withdrawn with
 *    [3.10.8](docs/project/prd.md) and [3.10.10](docs/project/prd.md); nothing of them remains.
 * 2. **Two arms, {@link SearchQuery.perArm} candidates each.** The vector arm orders by cosine
 *    distance over the HNSW index and carries the distance out as a **similarity**, `1 - distance`;
 *    the word arm matches `websearch_to_tsquery` against the same `text` the vector was computed
 *    from, under the GIN expression index of migration 0037, ranked by `ts_rank_cd`. The
 *    configuration is `english` in both places, because an index under one configuration is not
 *    used by a query under another. `websearch_to_tsquery` rather than `plainto_tsquery` so a
 *    member's quotes and minus signs mean what they expect, and so `Romans 8:28` becomes the three
 *    lexemes a transcript that says it also holds ([3.10.5](docs/project/prd.md)). **Either arm
 *    may be absent**: no vector (the provider failed, or the member chose "Words only") empties the
 *    vector arm; a blend of one empties the word arm.
 * 3. **Weighted reciprocal rank fusion**, `s / (K + vector_rank) + (1 - s) / (K + text_rank)`
 *    summed over the arms a row appears in, with `s` the member's blend bound as a parameter. Rank
 *    fusion rather than score fusion because a cosine distance and a `ts_rank` are not on one
 *    scale and no weighting of them would be honest; sixty is the constant the method was
 *    published with. At the balanced stop a row both arms placed outranks a row either placed
 *    alone, which is what a search for the words a teaching uses *and* means should do.
 * 4. **The per-teaching cap**, as a window function over the recording after fusion and before
 *    the page limit: a long teaching that says the words in forty passages keeps its strongest
 *    one or three and the page still fills with other teachings. "Every moment" skips the cap.
 * 5. **Read the sources back**, joined by kind. A `segment` row is a **passage window**
 *    (`@thp/shared` `passages.ts`): its text is the passage, its `source_id` is the window's first
 *    non-filler sentence and therefore the seek point, and the context lines are the sentence
 *    *before the window's first sentence* and the sentence *after its last* — read off the window
 *    extent the embed step stored on the row, never lines inside the window, which the passage
 *    already holds ([3.10.6](docs/project/prd.md)). A row the word arm placed also comes back as
 *    `passageMarked`: `ts_headline` over the whole passage with the matched terms wrapped in
 *    {@link SEARCH_MARK_START} and {@link SEARCH_MARK_END} — characters the page splits on, never
 *    HTML. The context lines are never marked.
 *
 * **Kinds.** `SEARCHABLE_KINDS` is the universe and the request names a subset of it; this module
 * applies what it is given. A `recording` or `summary` hit has no moment: `start_ms` is null and
 * the member opens the teaching where they left it.
 */

export interface SearchQuery {
  readonly readerId: string;
  readonly queryText: string;
  /** The embedded query, or `null` to run the word arm alone. */
  readonly queryVector: readonly number[] | null;
  /** The kinds searched. Never empty. */
  readonly kinds: readonly SearchableKind[];
  /** The meaning arm's weight, `0..1`. At `1` the word arm does not run. */
  readonly blend: SearchBlend;
  /** Rows kept per recording after fusion; `null` keeps every row. */
  readonly perTeaching: SearchPerTeaching;
  /** Candidates per arm before fusion. */
  readonly perArm: number;
  /** Fused rows skipped before the first returned. */
  readonly offset: number;
  /** Fused rows returned. */
  readonly limit: number;
}

/** One fused row, with what a result needs read back beside it. */
export interface SearchHitRow {
  readonly embeddingId: string;
  readonly sourceKind: SearchableKind;
  readonly sourceId: string;
  readonly recordingId: string;
  readonly recordingTitle: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  readonly seriesArtworkKey: string | null;
  /** The passage: a window's sentences, a chapter's title and summary, a note, a summary, a recording's own words. */
  readonly text: string;
  /** The passage with matched terms marked when the word arm placed the row; otherwise `text` itself. */
  readonly textMarked: string;
  /** The seek point; `null` for a recording or summary hit, and for a note on the whole teaching. */
  readonly startMs: number | null;
  /** The transcript line before a window's first sentence; `null` for a first line and for every other kind. */
  readonly before: string | null;
  /** The transcript line after a window's last sentence; `null` for a last line and for every other kind. */
  readonly after: string | null;
  readonly vectorRank: number | null;
  readonly textRank: number | null;
  /** Cosine similarity, `1 - distance`, for a row the vector arm placed; `null` otherwise. */
  readonly similarity: number | null;
  readonly score: number;
}

/** The text-search configuration, spelled here and in the index of migration 0037 and nowhere else. */
const TEXT_SEARCH_CONFIG = 'english';

/** The reciprocal-rank-fusion constant. See the module comment. */
const FUSION_K = 60;

export async function searchEmbeddings(
  query: SearchQuery,
  executor: Executor = getDatabase(),
): Promise<SearchHitRow[]> {
  const { readerId } = query;

  // Everything both arms agree on: who may see the row and which kinds are searched. Built once
  // and spliced into each arm, so the two cannot drift.
  const kinds = sql.join(
    query.kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const candidates = sql`from ${embedding}
    where ${embeddingVisibleTo(readerId)}
      and ${embedding.sourceKind} in (${kinds})
      and ${embedding.recordingId} is not null`;

  const tsQuery = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query.queryText})`;
  const tsVector = sql`to_tsvector(${TEXT_SEARCH_CONFIG}, ${embedding.text})`;

  // An arm that does not run is an empty set, spelled as a query so the fusion below is one shape.
  // The distance is computed once and carried out as a similarity beside the rank.
  const vectorArm =
    query.queryVector === null
      ? sql`select null::uuid as id, null::bigint as rank, null::float8 as similarity where false`
      : sql`select ${embedding.id} as id,
              row_number() over (order by ${embedding.embedding} <=> ${vectorLiteral(query.queryVector)}::vector) as rank,
              (1 - (${embedding.embedding} <=> ${vectorLiteral(query.queryVector)}::vector))::float8 as similarity
            ${candidates}
            order by ${embedding.embedding} <=> ${vectorLiteral(query.queryVector)}::vector
            limit ${query.perArm}`;

  // Normalisation `1` divides the rank by `1 + log(document length)`: a passage that *is* the
  // words outranks a long note that mentions them once, which is the order a member reading for
  // the moment a thing was said wants. Without it the two tie and the tie breaks on an id.
  const textRank = sql`ts_rank_cd(${tsVector}, ${tsQuery}, 1)`;
  const textArm =
    query.blend === 1
      ? sql`select null::uuid as id, null::bigint as rank where false`
      : sql`select ${embedding.id} as id,
          row_number() over (order by ${textRank} desc, ${embedding.id}) as rank
        ${candidates}
          and ${tsVector} @@ ${tsQuery}
        order by ${textRank} desc, ${embedding.id}
        limit ${query.perArm}`;

  const k = sql.raw(String(FUSION_K));
  const blend = sql`${query.blend}::float8`;

  // The window's ends. A row written before the extent columns existed is a window of one
  // sentence, so both ends fall back to the source itself.
  const windowFirst = sql`coalesce(${embedding.windowFirstSegmentId}, ${embedding.sourceId})`;
  const windowLast = sql`coalesce(${embedding.windowLastSegmentId}, ${embedding.sourceId})`;

  // The whole passage with every matched term wrapped: `HighlightAll` keeps the text intact
  // rather than cutting fragments, and the markers are the page's, not HTML.
  const headlineOptions = `StartSel=${SEARCH_MARK_START}, StopSel=${SEARCH_MARK_END}, HighlightAll=true`;
  const textMarked = sql`case
      when f.text_rank is not null
        then ts_headline(${TEXT_SEARCH_CONFIG}, ${embedding.text}, ${tsQuery}, ${headlineOptions})
      else ${embedding.text}
    end`;

  const perTeaching =
    query.perTeaching === null ? sql`` : sql`where r.per_teaching <= ${query.perTeaching}`;

  const rows = await queryable(executor).execute(sql`
    with by_vector as (${vectorArm}),
    by_words as (${textArm}),
    fused as (
      select
        coalesce(v.id, w.id) as id,
        v.rank as vector_rank,
        w.rank as text_rank,
        v.similarity as similarity,
        coalesce(${blend} / (${k} + v.rank), 0)
          + coalesce((1 - ${blend}) / (${k} + w.rank), 0) as score
      from by_vector v
      full outer join by_words w on w.id = v.id
    ),
    ranked as (
      select
        fused.*,
        row_number() over (
          partition by e.recording_id
          order by fused.score desc, fused.vector_rank asc nulls last, fused.text_rank asc nulls last, fused.id
        ) as per_teaching
      from fused
      join ${embedding} e on e.id = fused.id
    )
    select
      f.id as embedding_id,
      ${embedding.sourceKind} as source_kind,
      ${embedding.sourceId} as source_id,
      ${embedding.recordingId} as recording_id,
      ${recording.title} as recording_title,
      ${recording.recordedAt}::text as recorded_at,
      ${series.id} as series_id,
      ${series.title} as series_title,
      ${series.artworkKey} as series_artwork_key,
      ${embedding.text} as text,
      ${textMarked} as text_marked,
      case ${embedding.sourceKind}
        when 'segment' then ${segment.startMs}
        when 'chapter' then ${chapter.startMs}
        when 'note' then ${note.timestampMs}
      end as start_ms,
      before_line.text as before,
      after_line.text as after,
      f.vector_rank,
      f.text_rank,
      f.similarity,
      f.score::float8 as score
    from (select r.* from ranked r ${perTeaching}) f
    join ${embedding} on ${embedding.id} = f.id
    join ${recording} on ${recording.id} = ${embedding.recordingId}
    left join ${series} on ${series.id} = ${recording.seriesId}
    left join ${segment} on ${embedding.sourceKind} = 'segment' and ${segment.id} = ${embedding.sourceId}
    left join ${segment} first_line on ${embedding.sourceKind} = 'segment' and first_line.id = ${windowFirst}
    left join ${segment} last_line on ${embedding.sourceKind} = 'segment' and last_line.id = ${windowLast}
    left join ${chapter} on ${embedding.sourceKind} = 'chapter' and ${chapter.id} = ${embedding.sourceId}
    left join ${note} on ${embedding.sourceKind} = 'note' and ${note.id} = ${embedding.sourceId}
    left join lateral (
      select earlier.text from ${segment} earlier
      where first_line.id is not null
        and earlier.transcript_id = first_line.transcript_id
        and earlier.start_ms < first_line.start_ms
      order by earlier.start_ms desc limit 1
    ) before_line on true
    left join lateral (
      select later.text from ${segment} later
      where last_line.id is not null
        and later.transcript_id = last_line.transcript_id
        and later.start_ms > last_line.start_ms
      order by later.start_ms asc limit 1
    ) after_line on true
    order by f.score desc, f.vector_rank asc nulls last, f.text_rank asc nulls last, f.id
    offset ${query.offset}
    limit ${query.limit}
  `);

  return (rows as unknown as RawRow[]).map((row) => ({
    embeddingId: row.embedding_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    recordingId: row.recording_id,
    recordingTitle: row.recording_title,
    recordedAt: row.recorded_at,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    seriesArtworkKey: row.series_artwork_key,
    text: row.text,
    textMarked: row.text_marked,
    startMs: row.start_ms,
    before: row.before,
    after: row.after,
    vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
    textRank: row.text_rank === null ? null : Number(row.text_rank),
    similarity: row.similarity === null ? null : Number(row.similarity),
    score: Number(row.score),
  }));
}

interface RawRow {
  readonly embedding_id: string;
  readonly source_kind: SearchableKind;
  readonly source_id: string;
  readonly recording_id: string;
  readonly recording_title: string;
  readonly recorded_at: string;
  readonly series_id: string | null;
  readonly series_title: string | null;
  readonly series_artwork_key: string | null;
  readonly text: string;
  readonly text_marked: string;
  readonly start_ms: number | null;
  readonly before: string | null;
  readonly after: string | null;
  /** `bigint` from `row_number`, which the driver hands back as a string. */
  readonly vector_rank: string | number | null;
  readonly text_rank: string | number | null;
  readonly similarity: string | number | null;
  readonly score: number | string;
}

/**
 * A vector as pgvector's input syntax — `[0.1,0.2,…]`. Bound as one text parameter and cast, so
 * fifteen hundred numbers travel as one value rather than as fifteen hundred placeholders.
 */
function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
