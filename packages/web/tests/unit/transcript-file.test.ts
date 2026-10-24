import { describe, expect, it } from 'vitest';
import { transcriptFileName, transcriptFileText } from '@/client/transcript/transcript-file';

/**
 * **The downloadable transcript, decided without a browser.** The component hands these two
 * answers to an anchor or to the shell's filesystem; what is in the file and what it is called
 * is settled here.
 */

describe('the text of the file', () => {
  it('writes one timecoded line per segment, in order, each ending in a newline', () => {
    expect(
      transcriptFileText([
        { startMs: 0, text: 'In the beginning.' },
        { startMs: 65_000, text: '  Padded words.  ' },
        { startMs: 3_600_000, text: 'An hour in.' },
      ]),
    ).toBe('[00:00] In the beginning.\n[01:05] Padded words.\n[1:00:00] An hour in.\n');
  });

  it('is empty for no lines', () => {
    expect(transcriptFileText([])).toBe('');
  });
});

describe('the name of the file', () => {
  it('is the teaching’s title, marked as a transcript', () => {
    expect(transcriptFileName('The Sermon on the Mount')).toBe('The Sermon on the Mount - transcript.txt');
  });

  it('adds the chapter’s title on the chapter page', () => {
    expect(transcriptFileName('The Sermon on the Mount', 'The Beatitudes')).toBe(
      'The Sermon on the Mount - The Beatitudes - transcript.txt',
    );
  });

  it('replaces the characters a filesystem refuses and collapses whitespace', () => {
    expect(transcriptFileName('Faith: Part 1/2?  "Hope"\n')).toBe('Faith- Part 1-2- -Hope- - transcript.txt');
  });

  it('falls back to a bare name when the title reduces to nothing', () => {
    expect(transcriptFileName('   ')).toBe('transcript.txt');
    expect(transcriptFileName('', '')).toBe('transcript.txt');
  });
});
