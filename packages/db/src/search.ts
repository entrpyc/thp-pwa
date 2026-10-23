import { sql } from 'drizzle-orm';
import { SEARCHABLE_KINDS, type SearchableKind } from '@thp/shared';
import { getDatabase, queryable, type Executor } from './client';
import {
  chapter,
  embedding,
  note,
  recording,
  recordingTag,
  scriptureReference,
  segment,
  series,
  seriesTag,
} from './schema';
import { embeddingVisibleTo } from './visibility';

/**
 * **The search query** ([3.10](docs/project/prd.md); project tdd 4.5) — the one `<=>` in the
 * repository, and the fusion around it, which `embeddings.ts` deliberately left to the caller
 * that would know what it was for.
 *
 * One statement, in four steps, and the order of the steps is the design:
 *
 * 1. **Visibility and filters first, inside each arm.** [3.10.9](docs/project/prd.md) is applied
 *    as `embeddingVisibleTo` *before* either `limit`, together with every filter of
 *    [3.10.8](docs/project/prd.md). Filtering after a top-k is what breaks top-k — a member whose
 *    forty nearest rows were all somebody else's private notes would get nothing — and keeping the
 *    vectors beside the permission rows so this could be a `where` is the whole of project tdd
 *    4.4. The predicate is imported, never restated: `tests/guards/visibility-boundary` refuses a
 *    second spelling.
 * 2. **Two arms, {@link perArm} candidates each.** The vector arm orders by cosine distance over
 *    the HNSW index; the word arm matches `websearch_to_tsquery` against the same `text` the
 *    vector was computed from, under the GIN expression index of migration 0037, ranked by
 *    `ts_rank_cd`. The configuration is `english` in both places, because an index under one
 *    configuration is not used by a query under another. `websearch_to_tsquery` rather than
 *    `plainto_tsquery` so a member's quotes and minus signs mean what they expect, and so
 *    `Romans 8:28` becomes the three lexemes a transcript that says it also holds
 *    ([3.10.5](docs/project/prd.md)).
 * 3. **Reciprocal rank fusion**, `1 / (60 + rank)` summed over the arms a row appears in. Rank
 *    fusion rather than score fusion because a cosine distance and a `ts_rank` are not on one
 *    scale and no weighting of them would be honest; sixty is the constant the method was
 *    published with and there is no library here to tune it against yet. A row both arms placed
 *    outranks a row either placed alone, which is what a search for the words a teaching uses
 *    *and* means should do.
 * 4. **Read the sources back**, joined by kind, with the neighbouring transcript lines for a
 *    segment so the passage reads in context ([3.10.6](docs/project/prd.md)).
 *
 * **The query vector may be absent.** When the provider failed, the caller passes `null` and the
 * word arm runs alone — the degraded answer the operator chose over no answer
 * ([3.10.11](docs/project/prd.md)). The fusion is unchanged; every row simply has one rank.
 *
 * **Kinds.** `SEARCHABLE_KINDS` is read from `@thp/shared`, where the decision to leave the
 * published summary out is argued; this module applies it and does not re-argue it.
 *
 * **Filters, in words.** A series is the recording's `series_id`. A date range is inclusive over
 * `recorded_at`, the day the teaching was given. A tag matches when it is on the recording *or on
 * its series*, because a tag on a study applies to the teachings in it
 * ([3.3.13](docs/project/prd.md)). A book matches when the recording cites any passage of it
 * ([3.7](docs/project/prd.md)). "Only mine" keeps notes whose `author_id` is the reader — public
 * and private alike, which is why it joins `note` rather than reading the vector row's
 * `owner_user_id`, set on private notes alone ([3.10.10](docs/project/prd.md)).
 */

export interface SearchFilters {
  readonly seriesId: string | null;
  /** Inclusive `YYYY-MM-DD` bounds over `recording.recorded_at`. */
  readonly recordedFrom: string | null;
  readonly recordedTo: string | null;
  readonly tagId: string | null;
  /** A book identity as `scripture_reference.book` stores it. */
  readonly book: string | null;
  readonly onlyMine: boolean;
}

export interface SearchQuery {
  readonly readerId: string;
  readonly queryText: string;
  /** The embedded query, or `null` to run the word arm alone. */
  readonly queryVector: readonly number[] | null;
  readonly filters: SearchFilters;
  /** Candidates per arm before fusion. */
  readonly perArm: number;
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
  readonly text: string;
  readonly startMs: number | null;
  /** The transcript line before a segment hit; `null` for a first line and for every other kind. */
  readonly before: string | null;
  readonly after: string | null;
  readonly vectorRank: number | null;
  readonly textRank: number | null;
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
  const { readerId, filters } = query;

  // Everything both arms agree on: who may see the row, which kinds are searched, and every
  // filter. Built once and spliced into each arm, so the two cannot drift.
  const kinds = sql.join(
    SEARCHABLE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  const conditions = [
    embeddingVisibleTo(readerId),
    sql`${embedding.sourceKind} in (${kinds})`,
    sql`${embedding.recordingId} is not null`,
  ];
  if (filters.seriesId !== null) {
    conditions.push(sql`${recording.seriesId} = ${filters.seriesId}::uuid`);
  }
  if (filters.recordedFrom !== null) {
    conditions.push(sql`${recording.recordedAt} >= ${filters.recordedFrom}::date`);
  }
  if (filters.recordedTo !== null) {
    conditions.push(sql`${recording.recordedAt} <= ${filters.recordedTo}::date`);
  }
  if (filters.tagId !== null) {
    conditions.push(sql`(
      exists (
        select 1 from ${recordingTag}
        where ${recordingTag.recordingId} = ${recording.id}
          and ${recordingTag.tagId} = ${filters.tagId}::uuid
      )
      or exists (
        select 1 from ${seriesTag}
        where ${seriesTag.seriesId} = ${recording.seriesId}
          and ${seriesTag.tagId} = ${filters.tagId}::uuid
      )
    )`);
  }
  if (filters.book !== null) {
    conditions.push(sql`exists (
      select 1 from ${scriptureReference}
      where ${scriptureReference.recordingId} = ${recording.id}
        and ${scriptureReference.book} = ${filters.book}
    )`);
  }
  if (filters.onlyMine) {
    conditions.push(sql`(
      ${embedding.sourceKind} = 'note'
      and exists (
        select 1 from ${note}
        where ${note.id} = ${embedding.sourceId} and ${note.authorId} = ${readerId}::uuid
      )
    )`);
  }
  const where = sql.join(conditions, sql` and `);

  // `recording` is joined in both arms only for the filters; the visibility predicate carries its
  // own correlated `exists` and does not read the join.
  const candidates = sql`from ${embedding}
    join ${recording} on ${recording.id} = ${embedding.recordingId}
    where ${where}`;

  const tsQuery = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${query.queryText})`;
  const tsVector = sql`to_tsvector(${TEXT_SEARCH_CONFIG}, ${embedding.text})`;

  // Without a vector the arm is an empty set, spelled as a query so the fusion below is one shape.
  const vectorArm =
    query.queryVector === null
      ? sql`select null::uuid as id, null::bigint as rank where false`
      : sql`select ${embedding.id} as id,
              row_number() over (order by ${embedding.embedding} <=> ${vectorLiteral(query.queryVector)}::vector) as rank
            ${candidates}
            order by ${embedding.embedding} <=> ${vectorLiteral(query.queryVector)}::vector
            limit ${query.perArm}`;

  // Normalisation `1` divides the rank by `1 + log(document length)`: a transcript line that *is*
  // the words outranks a long note that mentions them once, which is the order a member reading
  // for the moment a thing was said wants. Without it the two tie and the tie breaks on an id.
  const textRank = sql`ts_rank_cd(${tsVector}, ${tsQuery}, 1)`;
  const textArm = sql`select ${embedding.id} as id,
      row_number() over (order by ${textRank} desc, ${embedding.id}) as rank
    ${candidates}
      and ${tsVector} @@ ${tsQuery}
    order by ${textRank} desc, ${embedding.id}
    limit ${query.perArm}`;

  const rows = await queryable(executor).execute(sql`
    with by_vector as (${vectorArm}),
    by_words as (${textArm}),
    fused as (
      select
        coalesce(v.id, w.id) as id,
        v.rank as vector_rank,
        w.rank as text_rank,
        coalesce(1.0 / (${sql.raw(String(FUSION_K))} + v.rank), 0)
          + coalesce(1.0 / (${sql.raw(String(FUSION_K))} + w.rank), 0) as score
      from by_vector v
      full outer join by_words w on w.id = v.id
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
      case ${embedding.sourceKind}
        when 'segment' then ${segment.startMs}
        when 'chapter' then ${chapter.startMs}
        when 'note' then ${note.timestampMs}
      end as start_ms,
      before_line.text as before,
      after_line.text as after,
      f.vector_rank,
      f.text_rank,
      f.score::float8 as score
    from fused f
    join ${embedding} on ${embedding.id} = f.id
    join ${recording} on ${recording.id} = ${embedding.recordingId}
    left join ${series} on ${series.id} = ${recording.seriesId}
    left join ${segment} on ${embedding.sourceKind} = 'segment' and ${segment.id} = ${embedding.sourceId}
    left join ${chapter} on ${embedding.sourceKind} = 'chapter' and ${chapter.id} = ${embedding.sourceId}
    left join ${note} on ${embedding.sourceKind} = 'note' and ${note.id} = ${embedding.sourceId}
    left join lateral (
      select earlier.text from ${segment} earlier
      where ${segment.id} is not null
        and earlier.transcript_id = ${segment.transcriptId}
        and earlier.start_ms < ${segment.startMs}
      order by earlier.start_ms desc limit 1
    ) before_line on true
    left join lateral (
      select later.text from ${segment} later
      where ${segment.id} is not null
        and later.transcript_id = ${segment.transcriptId}
        and later.start_ms > ${segment.startMs}
      order by later.start_ms asc limit 1
    ) after_line on true
    order by f.score desc, f.vector_rank asc nulls last, f.text_rank asc nulls last, f.id
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
    startMs: row.start_ms,
    before: row.before,
    after: row.after,
    vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
    textRank: row.text_rank === null ? null : Number(row.text_rank),
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
  readonly start_ms: number | null;
  readonly before: string | null;
  readonly after: string | null;
  /** `bigint` from `row_number`, which the driver hands back as a string. */
  readonly vector_rank: string | number | null;
  readonly text_rank: string | number | null;
  readonly score: number | string;
}

/**
 * A vector as pgvector's input syntax — `[0.1,0.2,…]`. Bound as one text parameter and cast, so
 * fifteen hundred numbers travel as one value rather than as fifteen hundred placeholders.
 */
function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
