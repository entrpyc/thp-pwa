/**
 * **How much of a segment the caption pill shows at once.**
 *
 * `segmentAt` answers *which* line is being spoken; a sentence is not, however, a subtitle. The ASR
 * hands back whole sentences, and a preacher's sentence runs long — a 400-character run-on arrives
 * as one segment with one start and one end, and the pill of `bottom-navigation/subtitles.png` then
 * grows to four or five lines and eats the controls under it.
 *
 * So the pill reads a **caption line** rather than a segment: the segment's text cut into pieces of
 * at most {@link MAX_CAPTION_CHARS} characters, with the piece belonging to the current moment
 * shown. Nothing is dropped — a long sentence is paced through the pill across the seconds it is
 * actually being said, which is what a subtitle track does.
 *
 * Pure, in its own module, and tested without a clock, for the same reason `current-segment.ts` is.
 *
 * Three rules:
 *
 * - **Break on whitespace**, never mid-word. A word longer than the limit on its own (a URL, a
 *   transcription artefact) is hard-split, because the alternative is a piece that breaks the limit.
 * - **Time is shared by length.** Each piece holds the pill for the fraction of the segment its
 *   characters are of the whole, so a short tail does not sit on screen as long as a full line. The
 *   provider gives no word-level timing here, and even pacing across the sentence is the honest
 *   approximation of it.
 * - **The last piece owns the end.** Rounding at the final boundary must not answer "nothing" for
 *   the last millisecond of a sentence that is still being spoken.
 */

/**
 * The most characters one caption may carry.
 *
 * 130 is two comfortable lines in the pill at its 48rem cap — long enough that ordinary sentences
 * are never cut, short enough that the pill cannot climb over the transport bar.
 */
export const MAX_CAPTION_CHARS = 130;

/** The least a segment has to be for {@link captionAt} to pace it. */
export interface CaptionSource {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

/**
 * `text` cut into pieces of at most `maxChars` characters, in reading order.
 *
 * Empty or blank text yields no pieces at all — the caller shows its own "nothing is being said"
 * mark rather than an empty pill.
 */
export function captionLines(text: string, maxChars: number = MAX_CAPTION_CHARS): readonly string[] {
  const words = text.trim().split(/\s+/).filter((one) => one !== '');
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    // A single word past the limit cannot be wrapped into it, only broken — and what precedes it
    // is flushed first so the break happens at the word rather than through the sentence.
    if (word.length > maxChars) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      for (let at = 0; at < word.length; at += maxChars) {
        lines.push(word.slice(at, at + maxChars));
      }
      continue;
    }

    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current !== '') lines.push(current);
  return lines;
}

/**
 * The caption to show for `segment` at `offsetMs`, or `null` when it has no words to show.
 *
 * `offsetMs` outside the segment is clamped to it: the caller has already decided this segment is
 * the one being spoken (`segmentAt`), and a millisecond of drift at a boundary must not blank the
 * pill.
 */
export function captionAt(
  segment: CaptionSource,
  offsetMs: number,
  maxChars: number = MAX_CAPTION_CHARS,
): string | null {
  const lines = captionLines(segment.text, maxChars);
  const first = lines[0];
  if (first === undefined) return null;
  if (lines.length === 1) return first;

  const span = segment.endMs - segment.startMs;
  // A zero-length or inverted segment has no time to pace across; its opening piece is the answer.
  if (span <= 0) return first;

  const total = lines.reduce((sum, one) => sum + one.length, 0);
  const elapsed = Math.min(Math.max(offsetMs - segment.startMs, 0), span);
  const spoken = (elapsed / span) * total;

  let consumed = 0;
  for (const line of lines) {
    consumed += line.length;
    if (spoken < consumed) return line;
  }

  // Only the exact end of the segment reaches here, and it belongs to the piece still being said.
  return lines[lines.length - 1] ?? first;
}
