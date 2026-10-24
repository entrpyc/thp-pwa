import { describe, expect, it } from 'vitest';
import {
  PASSAGE_FILLER_MAX_WORDS,
  PASSAGE_WINDOW_MAX_MS,
  PASSAGE_WINDOW_MAX_WORDS,
  PASSAGE_WINDOW_STEP_MS,
  PASSAGE_WINDOW_STEP_WORDS,
  buildPassageWindows,
  isFillerSentence,
  windowsContaining,
  wordCount,
  type PassageSentence,
} from '../../src/passages';
import { firstParagraph, recordingMetadataText } from '../../src/embeddings';

/**
 * **The passage-window builder, against fixture transcripts** — fillers, long sentences and
 * paragraph breaks, each driving one clause of the rule the module comment states. The builder is
 * pure, so every assertion here is the whole truth about what the embed step writes for those
 * sentences and what the cross-reference step asks the index about.
 */

/** `count` distinct words, so a sentence's length is exactly what the test says. */
function words(count: number, seed: string): string {
  return Array.from({ length: count }, (_unused, index) => `${seed}${index}`).join(' ');
}

/** A transcript of sentences `durationMs` apart, each of `wordsEach` words, optionally in paragraphs. */
function transcript(
  count: number,
  options: { wordsEach: number; durationMs: number; paragraphs?: readonly number[] },
): PassageSentence[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `s${index}`,
    startMs: index * options.durationMs,
    endMs: (index + 1) * options.durationMs,
    text: `${words(options.wordsEach, `w${index}_`)}.`,
    paragraphIndex: options.paragraphs?.[index] ?? null,
  }));
}

function ids(window: { readonly segmentIds: readonly string[] }): string[] {
  return [...window.segmentIds];
}

describe('the constants say what the rule says', () => {
  it('steps by half a window, in words and in time', () => {
    expect(PASSAGE_WINDOW_STEP_WORDS * 2).toBe(PASSAGE_WINDOW_MAX_WORDS);
    expect(PASSAGE_WINDOW_STEP_MS * 2).toBe(PASSAGE_WINDOW_MAX_MS);
  });

  it('counts words as whitespace runs and calls three or fewer a filler', () => {
    expect(wordCount('  Alright?  ')).toBe(1);
    expect(wordCount('You see it?')).toBe(3);
    expect(isFillerSentence('You see it?')).toBe(true);
    expect(isFillerSentence('Turn with me please.')).toBe(false);
    expect(wordCount(words(PASSAGE_FILLER_MAX_WORDS + 1, 'x'))).toBe(PASSAGE_FILLER_MAX_WORDS + 1);
  });
});

describe('growing a window (rule 1)', () => {
  it('adds sentences until the word limit, and stops once a window reaches the transcript’s end', () => {
    // Seven sentences of forty words, five seconds each: three fit under 150 words, four do not.
    // The third window ends on the last sentence, so no window starts inside it.
    const sentences = transcript(7, { wordsEach: 40, durationMs: 5_000 });
    const windows = buildPassageWindows(sentences);

    expect(windows.map(ids)).toEqual([
      ['s0', 's1', 's2'],
      ['s2', 's3', 's4'],
      ['s4', 's5', 's6'],
    ]);
    expect(windows.map((window) => window.sourceId)).toEqual(['s0', 's2', 's4']);
    expect(windows[0]).toMatchObject({ firstSegmentId: 's0', lastSegmentId: 's2', startMs: 0, endMs: 15_000 });
    expect(windows[0]?.text).toBe(`${sentences[0]?.text} ${sentences[1]?.text} ${sentences[2]?.text}`);
    for (const window of windows) {
      expect(wordCount(window.text)).toBeLessThanOrEqual(PASSAGE_WINDOW_MAX_WORDS);
    }
  });

  it('stops at the time limit when the speaker is slow, whichever comes first', () => {
    // Five words a sentence, twenty-five seconds each: two fit under sixty seconds, three do not.
    const windows = buildPassageWindows(transcript(5, { wordsEach: 5, durationMs: 25_000 }));
    expect(windows.map(ids)).toEqual([
      ['s0', 's1'],
      ['s2', 's3'],
      ['s4'],
    ]);
    for (const window of windows) {
      expect(window.endMs - window.startMs).toBeLessThanOrEqual(PASSAGE_WINDOW_MAX_MS);
    }
  });

  it('makes a sentence longer than the limit a window of its own', () => {
    const sentences = transcript(3, { wordsEach: 20, durationMs: 5_000 });
    const long = { ...(sentences[1] as PassageSentence), text: `${words(200, 'long')}.` };
    const windows = buildPassageWindows([sentences[0] as PassageSentence, long, sentences[2] as PassageSentence]);
    expect(windows.map(ids)).toEqual([['s0'], ['s1'], ['s2']]);
  });

  it('answers nothing for an empty transcript', () => {
    expect(buildPassageWindows([])).toEqual([]);
  });
});

describe('preferring a paragraph break (rule 2)', () => {
  it('ends the window at a break that falls within the last two sentences', () => {
    // By words the first window would be s0–s2; the provider put s2 in a new paragraph.
    const windows = buildPassageWindows(
      transcript(6, { wordsEach: 40, durationMs: 5_000, paragraphs: [0, 0, 1, 1, 1, 1] }),
    );
    expect(windows[0] ? ids(windows[0]) : []).toEqual(['s0', 's1']);
    // And the next window starts where the paragraph does — nothing is skipped.
    expect(windows[1]?.firstSegmentId).toBe('s2');
  });

  it('prefers the later of two breaks, and ignores a break further back than two sentences', () => {
    // Breaks before s1 and before s2: the one before s2 is nearer the end and wins.
    const nearer = buildPassageWindows(
      transcript(6, { wordsEach: 40, durationMs: 5_000, paragraphs: [0, 1, 2, 2, 2, 2] }),
    );
    expect(nearer[0] ? ids(nearer[0]) : []).toEqual(['s0', 's1']);

    // Twenty words a sentence: seven fit by words. A break before s2 is five sentences back from
    // the window's end and is not what "the last two sentences" means.
    const far = buildPassageWindows(
      transcript(9, { wordsEach: 20, durationMs: 5_000, paragraphs: [0, 0, 1, 1, 1, 1, 1, 1, 1] }),
    );
    expect(far[0] ? ids(far[0]) : []).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
  });

  it('does not shorten the last window of the transcript', () => {
    const windows = buildPassageWindows(
      transcript(3, { wordsEach: 40, durationMs: 5_000, paragraphs: [0, 0, 1] }),
    );
    expect(windows.map(ids)).toEqual([['s0', 's1', 's2']]);
  });

  it('reads a null paragraph index as no information, never as a break', () => {
    const withNulls = buildPassageWindows(
      transcript(6, { wordsEach: 40, durationMs: 5_000, paragraphs: [0, 0, 1, 1, 1, 1] }).map(
        (sentence, index) => (index === 1 ? { ...sentence, paragraphIndex: null } : sentence),
      ),
    );
    expect(withNulls[0] ? ids(withNulls[0]) : []).toEqual(['s0', 's1', 's2']);
    const none = buildPassageWindows(transcript(6, { wordsEach: 40, durationMs: 5_000 }));
    expect(none[0] ? ids(none[0]) : []).toEqual(['s0', 's1', 's2']);
  });
});

describe('stepping forward by half a window (rule 3)', () => {
  it('overlaps consecutive windows by about half', () => {
    const windows = buildPassageWindows(transcript(12, { wordsEach: 25, durationMs: 5_000 }));
    // Six sentences fit (150 words); the step passes 75 words after three sentences.
    expect(windows[0] ? ids(windows[0]) : []).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(windows[1] ? ids(windows[1]) : []).toEqual(['s3', 's4', 's5', 's6', 's7', 's8']);
    expect(windows[2] ? ids(windows[2]) : []).toEqual(['s6', 's7', 's8', 's9', 's10', 's11']);
  });

  it('steps by time for a slow speaker', () => {
    // Twelve seconds a sentence, five words: the window holds five sentences, the step passes
    // thirty seconds after three.
    const windows = buildPassageWindows(transcript(8, { wordsEach: 5, durationMs: 12_000 }));
    expect(windows[0] ? ids(windows[0]) : []).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(windows[1]?.firstSegmentId).toBe('s3');
  });

  it('never leaves a sentence out of every window', () => {
    for (const sentences of [
      transcript(23, { wordsEach: 37, durationMs: 7_000 }),
      transcript(17, { wordsEach: 3, durationMs: 9_000 }),
      transcript(11, { wordsEach: 80, durationMs: 50_000, paragraphs: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5] }),
    ]) {
      const covered = new Set(buildPassageWindows(sentences).flatMap(ids));
      const contentful = sentences.filter((sentence) => !isFillerSentence(sentence.text));
      for (const sentence of contentful) expect(covered.has(sentence.id), sentence.id).toBe(true);
    }
  });
});

describe('fillers (rule 4)', () => {
  const FILLERS = ['Alright?', 'You see it?', 'Okay.', 'Amen.'];

  it('emits no window for a stretch of fillers only', () => {
    const sentences = FILLERS.map((text, index) => ({
      id: `f${index}`,
      startMs: index * 2_000,
      endMs: (index + 1) * 2_000,
      text,
      paragraphIndex: null,
    }));
    expect(buildPassageWindows(sentences)).toEqual([]);
  });

  it('keeps fillers in the text but anchors the window on the first real sentence', () => {
    const sentences: PassageSentence[] = [
      { id: 'f0', startMs: 0, endMs: 1_000, text: 'Alright?', paragraphIndex: null },
      { id: 's1', startMs: 1_000, endMs: 6_000, text: 'The vine is Christ himself and we abide.', paragraphIndex: null },
      { id: 'f2', startMs: 6_000, endMs: 7_000, text: 'You see it?', paragraphIndex: null },
      { id: 's3', startMs: 7_000, endMs: 12_000, text: 'The branches are those who remain in him.', paragraphIndex: null },
    ];
    const windows = buildPassageWindows(sentences);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      sourceId: 's1',
      firstSegmentId: 'f0',
      lastSegmentId: 's3',
      startMs: 0,
      endMs: 12_000,
      text: 'Alright? The vine is Christ himself and we abide. You see it? The branches are those who remain in him.',
    });
  });

  it('never emits two windows anchored on the same sentence', () => {
    // A filler that lasts longer than the step, so the step lands on the sentence the first
    // window was anchored on; the second window would be keyed on the same row.
    const sentences: PassageSentence[] = [
      { id: 'f0', startMs: 0, endMs: 35_000, text: 'Hmm.', paragraphIndex: null },
      ...transcript(6, { wordsEach: 40, durationMs: 4_000 }).map((sentence) => ({
        ...sentence,
        startMs: sentence.startMs + 35_000,
        endMs: sentence.endMs + 35_000,
      })),
    ];
    const windows = buildPassageWindows(sentences);
    const sources = windows.map((window) => window.sourceId);
    expect(new Set(sources).size).toBe(sources.length);
    expect(windows[0]).toMatchObject({ sourceId: 's0', firstSegmentId: 'f0' });
    const covered = new Set(windows.flatMap(ids));
    for (let index = 0; index < 6; index += 1) expect(covered.has(`s${index}`)).toBe(true);
  });
});

describe('a fixture teaching with everything in it', () => {
  // Fillers, a long sentence, two paragraphs, a filler-only tail: what a real transcript holds.
  const sentences: PassageSentence[] = [
    { id: 'a', startMs: 0, endMs: 2_000, text: 'Good morning.', paragraphIndex: 0 },
    { id: 'b', startMs: 2_000, endMs: 12_000, text: `${words(60, 'open')}.`, paragraphIndex: 0 },
    { id: 'c', startMs: 12_000, endMs: 20_000, text: `${words(60, 'body')}.`, paragraphIndex: 0 },
    { id: 'd', startMs: 20_000, endMs: 21_000, text: 'Alright?', paragraphIndex: 0 },
    { id: 'e', startMs: 21_000, endMs: 40_000, text: `${words(120, 'long')}.`, paragraphIndex: 1 },
    { id: 'f', startMs: 40_000, endMs: 48_000, text: `${words(50, 'close')}.`, paragraphIndex: 1 },
    { id: 'g', startMs: 48_000, endMs: 49_000, text: 'Amen.', paragraphIndex: 2 },
    { id: 'h', startMs: 49_000, endMs: 50_000, text: 'Amen.', paragraphIndex: 2 },
  ];

  it('cuts it as the rule says', () => {
    const windows = buildPassageWindows(sentences);
    expect(windows.map(ids)).toEqual([
      // a+b+c+d is 124 words; e would make 244. The break before e is not within the last two
      // sentences' boundaries (before d, before c), so the window ends at the word limit.
      ['a', 'b', 'c', 'd'],
      // The step passes 75 words after c, so the next window starts at d. By words it would be
      // d+e (121), but the paragraph break before e is within its last two sentences, so it ends
      // at d — a filler alone, which is no window at all. The step from d is clamped to e, and e
      // alone is 120 words: f would make 170.
      ['e'],
      // From e the step passes 75 words at once: the next window starts at f.
      ['f', 'g', 'h'],
    ]);
    expect(windows.map((window) => window.sourceId)).toEqual(['b', 'e', 'f']);
    expect(windows[1]).toMatchObject({ firstSegmentId: 'e', lastSegmentId: 'e', startMs: 21_000 });
    // The filler-only tail rides in the last window's text rather than becoming a row.
    expect(windows[2]?.text.endsWith('Amen. Amen.')).toBe(true);
  });

  it('says which windows a corrected sentence touches', () => {
    const windows = buildPassageWindows(sentences);
    expect(windowsContaining(windows, 'd').map((window) => window.sourceId)).toEqual(['b']);
    expect(windowsContaining(windows, 'e').map((window) => window.sourceId)).toEqual(['e']);
    expect(windowsContaining(windows, 'h').map((window) => window.sourceId)).toEqual(['f']);
    expect(windowsContaining(windows, 'nope')).toEqual([]);
  });
});

describe('the recording row’s text', () => {
  it('joins title, description, series and the summary’s first paragraph as blocks', () => {
    expect(
      recordingMetadataText({
        title: '  The Vine and the Branches ',
        description: 'John 15, read slowly.',
        seriesTitle: 'Gospel of John',
        summary: 'Jesus calls himself the vine.\nWe are the branches.\n\nThe second paragraph is not here.',
      }),
    ).toBe(
      'The Vine and the Branches\n\nJohn 15, read slowly.\n\nSeries: Gospel of John\n\nJesus calls himself the vine. We are the branches.',
    );
  });

  it('is the title alone when nothing else is written', () => {
    expect(
      recordingMetadataText({ title: 'Epaphras', description: null, seriesTitle: null, summary: null }),
    ).toBe('Epaphras');
    expect(
      recordingMetadataText({ title: 'Epaphras', description: '   ', seriesTitle: '', summary: '\n\n' }),
    ).toBe('Epaphras');
  });

  it('reads the first paragraph past leading blank lines, and whole when there is one paragraph', () => {
    expect(firstParagraph('\n\n  First.  \n Second line. \n\nThird.')).toBe('First. Second line.');
    expect(firstParagraph('Only one paragraph here.')).toBe('Only one paragraph here.');
    expect(firstParagraph('   ')).toBe('');
  });
});
