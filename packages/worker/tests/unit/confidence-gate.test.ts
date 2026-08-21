import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_THRESHOLD,
  TRANSCRIPTION_GRANT_SECONDS,
  TRANSCRIPTION_LANGUAGE,
  isConfident,
} from '../../src/transcribe';

/**
 * The three numbers this ticket settles, each named once.
 *
 * A literal at the comparison would be a number nobody can find and nobody can move, and
 * docs/project/prd.md 3.5.8's "the machine doubted it" would be a rule spread across whichever
 * files happened to need it.
 */
describe('the confidence gate', () => {
  it('lets a transcript at the threshold through', () => {
    // At, not above. A boundary that is decided by whichever comparison somebody typed is a
    // boundary that moves the next time somebody types one.
    expect(isConfident(CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it('stops one just below it and passes one just above', () => {
    expect(isConfident(CONFIDENCE_THRESHOLD - 0.001)).toBe(false);
    expect(isConfident(CONFIDENCE_THRESHOLD + 0.001)).toBe(true);
  });

  it('reads the ends of the range the same way', () => {
    expect(isConfident(0)).toBe(false);
    expect(isConfident(1)).toBe(true);
  });

  it('is 0.6 — a first setting, not a measured one', () => {
    // The first real recording is what tells us whether it is right, which is why it is written
    // down as a number to argue with rather than tuned into the comparison.
    expect(CONFIDENCE_THRESHOLD).toBe(0.6);
  });
});

describe('the grant the provider is given', () => {
  it('expires after two hours', () => {
    // Long enough for the provider to fetch and process a 200 MB file, short enough that a URL that
    // leaked is not a standing grant to somebody's teaching.
    expect(TRANSCRIPTION_GRANT_SECONDS).toBe(2 * 60 * 60);
  });
});

describe('the language', () => {
  it('is English, pinned', () => {
    expect(TRANSCRIPTION_LANGUAGE).toBe('en');
  });
});
