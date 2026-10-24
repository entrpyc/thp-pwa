/**
 * **Passage windows** — the unit a transcript is embedded and cross-referenced in, decided once
 * here so the worker that writes the rows, the search that reads them back and the step that
 * links them cannot disagree about where a passage starts and ends.
 *
 * **Why windows rather than sentences.** A segment is one Deepgram sentence. A real 83-minute
 * teaching has about 950 of them, a quarter are fillers — "Alright?", "You see it?" — and a
 * thought is rarely finished inside one. A vector per sentence therefore embeds a fragment, and a
 * search for a concept the teacher spread over four sentences finds none of them; a vector per
 * window of roughly a paragraph embeds the thought ([3.10](docs/project/prd.md)).
 *
 * **The rule**, every number a constant below:
 *
 * 1. Start at a sentence. Add following sentences until the window holds
 *    {@link PASSAGE_WINDOW_MAX_WORDS} words or spans {@link PASSAGE_WINDOW_MAX_MS}, whichever
 *    comes first. A sentence that alone exceeds either is a window on its own.
 * 2. Prefer to end at a Deepgram paragraph break when one falls within the last
 *    {@link PASSAGE_PARAGRAPH_LOOKBACK_SENTENCES} sentences: the provider's paragraphs follow the
 *    speaker's pauses, and a window that ends where the speaker paused reads as a passage rather
 *    than as a cut. A sentence with no paragraph index — every segment written before the column
 *    existed — carries no break information, and nothing is inferred from it.
 * 3. Jump forward by half the window: from the window's first sentence, advance past
 *    {@link PASSAGE_WINDOW_STEP_WORDS} words or {@link PASSAGE_WINDOW_STEP_MS}, and start the
 *    next window at the next sentence. Windows overlap by about half, so a thought that straddles
 *    one boundary sits whole inside the neighbouring window. The jump never leaves a sentence
 *    uncovered: it is clamped to the sentence after the window's last. A window that reached the
 *    transcript's end is the last one — nothing starts inside it.
 * 4. A filler is a sentence of {@link PASSAGE_FILLER_MAX_WORDS} words or fewer. A window whose
 *    sentences are all fillers is never emitted, and a window's `sourceId` is its first
 *    non-filler sentence, so the seek point a search hit opens lands on content rather than on
 *    "Alright?".
 * 5. The text is the sentences joined with a space. The last window may be short; it is emitted
 *    unless it is fillers only.
 *
 * **The row is keyed on `sourceId`.** The `embedding` table's source kind stays `segment` and its
 * `source_id` is the window's first non-filler sentence; one row stands for the window that starts
 * there. That is what lets the embed step reconcile per window — a corrected sentence changes the
 * text of exactly the windows that contain it, and only those re-embed — and what lets a hit be
 * carried back to a moment in the teaching the way a sentence hit always was.
 */

/** The most words a window holds. About a spoken paragraph; what one vector can stand for well. */
export const PASSAGE_WINDOW_MAX_WORDS = 150;

/** The longest span a window covers, in milliseconds — a slow speaker's paragraph. */
export const PASSAGE_WINDOW_MAX_MS = 60_000;

/** How far the next window's start advances, in words: half the window, so windows overlap by half. */
export const PASSAGE_WINDOW_STEP_WORDS = 75;

/** The same step in time, for the slow speaker. */
export const PASSAGE_WINDOW_STEP_MS = 30_000;

/** How many sentences back from a window's end a paragraph break is preferred over the hard limit. */
export const PASSAGE_PARAGRAPH_LOOKBACK_SENTENCES = 2;

/** A sentence of this many words or fewer is a filler: never a seek point, never a window alone. */
export const PASSAGE_FILLER_MAX_WORDS = 3;

/** What the builder needs to know about a sentence. A `SegmentRow` is one; so is a fixture. */
export interface PassageSentence {
  readonly id: string;
  /** Inclusive start offset, milliseconds. The builder keeps the order it is given. */
  readonly startMs: number;
  /** Exclusive end offset, milliseconds. */
  readonly endMs: number;
  readonly text: string;
  /**
   * The provider's paragraph, as an index that rises through the transcript; two adjacent
   * sentences with different indexes have a paragraph break between them. `null` means "no
   * break information", never "a break".
   */
  readonly paragraphIndex: number | null;
}

/** One window, as the embed step writes it and the search reads it back. */
export interface PassageWindow {
  /** The first non-filler sentence's id — the row's `source_id` and the hit's seek point. */
  readonly sourceId: string;
  /** The window's first sentence, which may be a filler. Context before the passage precedes it. */
  readonly firstSegmentId: string;
  /** The window's last sentence. Context after the passage follows it. */
  readonly lastSegmentId: string;
  /** Every sentence in the window, in order. */
  readonly segmentIds: readonly string[];
  /** The first sentence's start — where the window begins, filler or not. */
  readonly startMs: number;
  /** The last sentence's end. */
  readonly endMs: number;
  /** The sentences' text joined with a space. */
  readonly text: string;
}

/** Words as whitespace-separated runs. Punctuation-only runs count; a sentence rarely has one. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** Whether a sentence is a filler by the one rule: {@link PASSAGE_FILLER_MAX_WORDS} words or fewer. */
export function isFillerSentence(text: string): boolean {
  return wordCount(text) <= PASSAGE_FILLER_MAX_WORDS;
}

/**
 * **Cut a transcript into windows** by the rule in the module comment. Pure: the same sentences
 * answer the same windows, which is what makes "re-embed only what changed" a comparison of text
 * rather than a guess.
 *
 * The sentences are taken in the order given, which the caller reads in playback order. An empty
 * transcript answers no windows.
 */
export function buildPassageWindows(sentences: readonly PassageSentence[]): PassageWindow[] {
  const windows: PassageWindow[] = [];
  const emitted = new Set<string>();
  const words = sentences.map((sentence) => wordCount(sentence.text));

  let start = 0;
  while (start < sentences.length) {
    const first = sentences[start] as PassageSentence;

    // Rule 1: grow until the next sentence would take the window over either limit.
    let end = start;
    let held = words[start] as number;
    while (end + 1 < sentences.length) {
      const next = sentences[end + 1] as PassageSentence;
      const nextWords = held + (words[end + 1] as number);
      const nextSpan = next.endMs - first.startMs;
      if (nextWords > PASSAGE_WINDOW_MAX_WORDS || nextSpan > PASSAGE_WINDOW_MAX_MS) break;
      held = nextWords;
      end += 1;
    }

    // Rule 2: a paragraph break just before one of the last few sentences ends the window there.
    // Only when the window stopped short of the transcript's end — the last window ends where
    // the transcript does — and only when both sides of the boundary carry an index.
    if (end + 1 < sentences.length) {
      for (let back = 0; back < PASSAGE_PARAGRAPH_LOOKBACK_SENTENCES; back += 1) {
        const boundary = end - back;
        if (boundary <= start) break;
        if (paragraphBreakBefore(sentences, boundary)) {
          end = boundary - 1;
          break;
        }
      }
    }

    // Rule 4: fillers only is nothing to embed; otherwise the seek point is the first real sentence.
    const inWindow = sentences.slice(start, end + 1);
    const anchor = inWindow.find((sentence) => !isFillerSentence(sentence.text));
    if (anchor !== undefined && !emitted.has(anchor.id)) {
      emitted.add(anchor.id);
      const last = inWindow[inWindow.length - 1] as PassageSentence;
      windows.push({
        sourceId: anchor.id,
        firstSegmentId: first.id,
        lastSegmentId: last.id,
        segmentIds: inWindow.map((sentence) => sentence.id),
        startMs: first.startMs,
        endMs: last.endMs,
        text: inWindow.map((sentence) => sentence.text).join(' '),
      });
    }

    // A window that reached the transcript's end is the last: another window starting inside it
    // would hold nothing the index does not already have.
    if (end + 1 >= sentences.length) break;

    // Rule 3: half a window on, clamped so nothing is skipped and the loop always advances.
    let next = start;
    let stepped = 0;
    while (next < sentences.length) {
      const sentence = sentences[next] as PassageSentence;
      stepped += words[next] as number;
      next += 1;
      if (stepped >= PASSAGE_WINDOW_STEP_WORDS) break;
      if (sentence.endMs - first.startMs >= PASSAGE_WINDOW_STEP_MS) break;
    }
    start = Math.max(start + 1, Math.min(next, end + 1));
  }

  return windows;
}

/** Whether a paragraph break sits between `sentences[index - 1]` and `sentences[index]`. */
function paragraphBreakBefore(sentences: readonly PassageSentence[], index: number): boolean {
  const before = sentences[index - 1]?.paragraphIndex ?? null;
  const after = sentences[index]?.paragraphIndex ?? null;
  return before !== null && after !== null && before !== after;
}

/**
 * **The windows that contain a sentence** — for a caller asking "which rows does this correction
 * touch". The builder answers it by construction; this is the lookup over its answer.
 */
export function windowsContaining(
  windows: readonly PassageWindow[],
  segmentId: string,
): PassageWindow[] {
  return windows.filter((window) => window.segmentIds.includes(segmentId));
}
