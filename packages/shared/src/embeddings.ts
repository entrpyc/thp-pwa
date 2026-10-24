/**
 * The embedding vocabulary — what semantic search ([3.10](docs/project/prd.md)) and
 * cross-referencing ([3.9](docs/project/prd.md)) are built on, stated once so the database column,
 * the worker's adapter and the search that reads them cannot disagree about the shape of a vector.
 *
 * **1536 dimensions** is project tdd 4.4's decision, and it is the model's native output rather
 * than a truncation: no step between the provider and the column changes what came back, which is
 * what makes "re-embed under a different model" the only migration there will ever be. The number
 * lives here rather than in the adapter because the *column* is sized by it — an adapter that
 * answered a different width would be refused by Postgres, and that refusal is the honest one.
 *
 * **The source kinds** are the things a vector can stand for. Each row in the `embedding` table
 * names one of these and the id of the row it was computed from, so a search hit can be carried
 * back to a moment in a teaching, a chapter, a note, a summary, a recording or a series.
 *
 * - `segment` — **a passage window, not a sentence.** The row's `source_id` is a segment id, and
 *   the row stands for the window that starts there: the sentence named plus the sentences after
 *   it up to the limits `passages.ts` states, joined as one text. Only window-start sentences have
 *   rows, and the start named is the window's first *non-filler* sentence, so the id is also the
 *   seek point. The window's first and last sentences ride on the row (`window_first_segment_id`,
 *   `window_last_segment_id`) so the read-back can find the lines either side of the passage.
 * - `recording` — the teaching's own words about itself: title, description, the series it is in
 *   and the first paragraph of its published summary, built by {@link recordingMetadataText}.
 *   `source_id` is the recording id and there is no moment to seek to.
 * - `series` is declared so the search scope can write those rows without a migration; nothing
 *   produces one yet. See `SEARCHABLE_KINDS` for why.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_SOURCE_KINDS = [
  'segment',
  'chapter',
  'note',
  'summary',
  'series',
  'recording',
] as const;

export type EmbeddingSourceKind = (typeof EMBEDDING_SOURCE_KINDS)[number];

export function isEmbeddingSourceKind(value: unknown): value is EmbeddingSourceKind {
  return (
    typeof value === 'string' && (EMBEDDING_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** What the recording row is built from. Every field is what the admin console or the chain wrote. */
export interface RecordingMetadataSource {
  readonly title: string;
  readonly description: string | null;
  /** The title of the series the recording is in, or `null` for the many in none. */
  readonly seriesTitle: string | null;
  /** The summary's content, **only when published**; the caller applies that gate. */
  readonly summary: string | null;
}

/**
 * **The text the recording row embeds** — title, description, series title and the published
 * summary's first paragraph, as blank-line-separated blocks, in that order, skipping what is
 * absent.
 *
 * The title alone is enough for a row, and a search for words that appear only in the title must
 * find it ([3.10.4](docs/project/prd.md)). The series title is prefixed so the vector carries
 * "this is part of a study called X" rather than a bare phrase. Only the summary's *first*
 * paragraph: the whole summary has a row of its own (`summary`), and repeating it here would
 * make one teaching two near-identical hits for the same words.
 *
 * Pure, so the embed step can compare it against the stored text and spend nothing when none of
 * the four changed.
 */
export function recordingMetadataText(source: RecordingMetadataSource): string {
  const blocks: string[] = [];
  const title = source.title.trim();
  if (title !== '') blocks.push(title);
  const description = (source.description ?? '').trim();
  if (description !== '') blocks.push(description);
  const seriesTitle = (source.seriesTitle ?? '').trim();
  if (seriesTitle !== '') blocks.push(`Series: ${seriesTitle}`);
  const opening = firstParagraph(source.summary ?? '');
  if (opening !== '') blocks.push(opening);
  return blocks.join('\n\n');
}

/**
 * The first paragraph of a text: the first run of non-blank lines, with each line trimmed and the
 * lines joined by a space. The summaries the chain writes are plain prose in paragraphs separated
 * by a blank line, so this is the opening paragraph as a reader would name it; a text with no
 * blank line is one paragraph and answers whole.
 */
export function firstParagraph(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (lines.length > 0) return lines.join(' ');
  }
  return '';
}
