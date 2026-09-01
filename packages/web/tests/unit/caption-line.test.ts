import { describe, expect, it } from 'vitest';
import { MAX_CAPTION_CHARS, captionAt, captionLines } from '@/client/transcript/caption-line';

/**
 * **The caption pill's character limit, driven across the shapes a sentence arrives in.**
 *
 * The ASR hands back sentences, and the pill shows subtitles — the two are not the same length.
 * These are the answers that keep a preacher's run-on sentence from growing the pill up over the
 * transport controls, without dropping a word of it.
 */

/** Predictable text: `n` words of four characters, so lengths are arithmetic rather than guessed. */
function words(count: number): string {
  return Array.from({ length: count }, (unused, index) => `w${String(index).padStart(3, '0')}`).join(
    ' ',
  );
}

describe('cutting a segment into caption lines', () => {
  it('leaves a sentence inside the limit whole', () => {
    const short = 'And he said unto them, follow me.';
    expect(captionLines(short)).toEqual([short]);
  });

  it('keeps every piece inside the limit', () => {
    const long = words(120);
    expect(long.length).toBeGreaterThan(MAX_CAPTION_CHARS * 3);
    for (const line of captionLines(long)) {
      expect(line.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    }
  });

  it('loses no words and breaks none', () => {
    const long = words(120);
    expect(captionLines(long).join(' ')).toBe(long);
  });

  it('breaks a word longer than the limit rather than exceeding it', () => {
    const artefact = 'x'.repeat(MAX_CAPTION_CHARS * 2 + 5);
    const lines = captionLines(`before ${artefact} after`);
    expect(lines[0]).toBe('before');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    expect(lines.join('').includes(artefact)).toBe(true);
  });

  it('collapses the whitespace a transcript carries', () => {
    expect(captionLines('  two   words \n here ')).toEqual(['two words here']);
  });

  it('answers nothing for text with no words in it', () => {
    expect(captionLines('')).toEqual([]);
    expect(captionLines('   \n ')).toEqual([]);
  });
});

describe('which caption a moment shows', () => {
  const SHORT = { startMs: 0, endMs: 4000, text: 'A short line.' };

  it('shows a short segment whole for the whole of it', () => {
    expect(captionAt(SHORT, 0)).toBe('A short line.');
    expect(captionAt(SHORT, 3999)).toBe('A short line.');
  });

  it('paces a long segment through its pieces in order', () => {
    const long = { startMs: 10_000, endMs: 30_000, text: words(120) };
    const lines = captionLines(long.text);
    expect(lines.length).toBeGreaterThan(2);

    expect(captionAt(long, 10_000)).toBe(lines[0]);
    // The very end of the sentence belongs to the piece still being said, not to nothing.
    expect(captionAt(long, 30_000)).toBe(lines[lines.length - 1]);

    // Walking the segment must walk the pieces: never backwards, never skipping one.
    const seen: string[] = [];
    for (let at = long.startMs; at <= long.endMs; at += 100) {
      const line = captionAt(long, at);
      if (line !== null && line !== seen[seen.length - 1]) seen.push(line);
    }
    expect(seen).toEqual(lines);
  });

  it('clamps an offset outside the segment to its ends', () => {
    const long = { startMs: 10_000, endMs: 30_000, text: words(120) };
    const lines = captionLines(long.text);
    expect(captionAt(long, 0)).toBe(lines[0]);
    expect(captionAt(long, 60_000)).toBe(lines[lines.length - 1]);
  });

  it('answers the opening piece for a segment with no duration to pace across', () => {
    const instant = { startMs: 5000, endMs: 5000, text: words(120) };
    expect(captionAt(instant, 5000)).toBe(captionLines(instant.text)[0]);
  });

  it('answers nothing for a segment with no words in it', () => {
    expect(captionAt({ startMs: 0, endMs: 1000, text: '   ' }, 500)).toBeNull();
  });
});
