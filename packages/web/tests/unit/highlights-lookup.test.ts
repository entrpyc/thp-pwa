import { describe, expect, it } from 'vitest';
import { UNSNAPPED_MOMENT_WINDOW_MS, type HighlightView } from '@thp/shared';
import {
  momentEntry,
  noteEntry,
  recordingEntry,
} from '@/app/(member)/highlights/highlights-lookup';

/**
 * The pure half of every pin control: which entry a control is about, read off the list
 * ([3.15](docs/project/prd.md)). The screens are driven in `highlights-screen.test.ts`; this file
 * pins down the arithmetic those screens share, where a browser would only get in the way.
 */

const RECORDING = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function entry(overrides: Partial<HighlightView> & Pick<HighlightView, 'id' | 'kind'>): HighlightView {
  return {
    pinnedAt: '2026-10-23T09:00:00.000Z',
    recording: { id: RECORDING, title: 'T', description: null, recordedAt: '2026-10-01', series: null },
    positionMs: null,
    segment: null,
    note: null,
    ...overrides,
  };
}

const whole = entry({ id: 'whole', kind: 'recording' });
const snapped = entry({
  id: 'snapped',
  kind: 'segment',
  positionMs: 10_000,
  segment: { startMs: 10_000, endMs: 14_000, text: 'A line.' },
});
const raw = entry({ id: 'raw', kind: 'segment', positionMs: 40_000 });
const ofNote = entry({ id: 'of-note', kind: 'note', positionMs: 25_000, note: { id: 'n1', text: 'Mine.' } });
const elsewhere = entry({
  id: 'elsewhere',
  kind: 'recording',
  recording: { id: OTHER, title: 'U', description: null, recordedAt: '2026-10-01', series: null },
});
const LIST = [whole, snapped, raw, ofNote, elsewhere];

describe('recordingEntry', () => {
  it('finds the whole-teaching entry for the recording and nothing for another', () => {
    expect(recordingEntry(LIST, RECORDING)?.id).toBe('whole');
    expect(recordingEntry(LIST, OTHER)?.id).toBe('elsewhere');
    expect(recordingEntry([snapped, ofNote], RECORDING)).toBeNull();
  });
});

describe('noteEntry', () => {
  it('finds the entry by the note it pins', () => {
    expect(noteEntry(LIST, 'n1')?.id).toBe('of-note');
    expect(noteEntry(LIST, 'n2')).toBeNull();
  });
});

describe('momentEntry', () => {
  it('covers a snapped line from its start up to, not including, its end', () => {
    expect(momentEntry(LIST, RECORDING, 10_000)?.id).toBe('snapped');
    expect(momentEntry(LIST, RECORDING, 13_999)?.id).toBe('snapped');
    expect(momentEntry(LIST, RECORDING, 14_000)).toBeNull();
    expect(momentEntry(LIST, RECORDING, 9_999)).toBeNull();
  });

  it('covers an unsnapped moment within the window either side', () => {
    expect(momentEntry(LIST, RECORDING, 40_000)?.id).toBe('raw');
    expect(momentEntry(LIST, RECORDING, 40_000 + UNSNAPPED_MOMENT_WINDOW_MS - 1)?.id).toBe('raw');
    expect(momentEntry(LIST, RECORDING, 40_000 - UNSNAPPED_MOMENT_WINDOW_MS + 1)?.id).toBe('raw');
    expect(momentEntry(LIST, RECORDING, 40_000 + UNSNAPPED_MOMENT_WINDOW_MS)).toBeNull();
  });

  it('never answers with a note or a whole teaching, and never across recordings', () => {
    expect(momentEntry(LIST, RECORDING, 25_000)).toBeNull();
    expect(momentEntry(LIST, OTHER, 10_000)).toBeNull();
  });

  it('prefers the nearer start when two entries could claim the moment', () => {
    const orphan = entry({ id: 'orphan', kind: 'segment', positionMs: 11_000 });
    expect(momentEntry([snapped, orphan], RECORDING, 11_500)?.id).toBe('orphan');
    expect(momentEntry([snapped, orphan], RECORDING, 10_200)?.id).toBe('snapped');
  });
});
