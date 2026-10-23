import { describe, expect, it } from 'vitest';
import { applySyncResults, toSyncEntries } from '@/client/offline/outbox';
import type { OutboxRecord } from '@/client/offline/schema';

/**
 * **Reading the sync answer against what was sent** (docs/project/prd.md 3.18.14, 3.18.15;
 * project tdd 5.3). The outbox's persistence is IndexedDB and is driven in the browser suite;
 * what a unit can hold is the decision — what leaves the outbox, what comes back as a draft, and
 * what is merely counted.
 */
const note = (clientId: string, recordingId: string): OutboxRecord => ({
  clientId,
  userId: 'u1',
  kind: 'note',
  recordingId,
  at: '2026-10-23T10:00:00.000Z',
  body: { text: `Note ${clientId}`, visibility: 'private', timestampMs: 12_000 },
});

const position = (clientId: string, recordingId: string): OutboxRecord => ({
  clientId,
  userId: 'u1',
  kind: 'progress',
  recordingId,
  at: '2026-10-23T10:01:00.000Z',
  body: { positionMs: 90_000 },
});

describe('the wire form', () => {
  it('drops the account the records are keyed under and keeps everything else', () => {
    expect(toSyncEntries([note('n1', 'r1'), position('p1', 'r2')])).toEqual([
      {
        clientId: 'n1',
        kind: 'note',
        recordingId: 'r1',
        at: '2026-10-23T10:00:00.000Z',
        body: { text: 'Note n1', visibility: 'private', timestampMs: 12_000 },
      },
      {
        clientId: 'p1',
        kind: 'progress',
        recordingId: 'r2',
        at: '2026-10-23T10:01:00.000Z',
        body: { positionMs: 90_000 },
      },
    ]);
  });
});

describe('applying the answer', () => {
  it('settles every answered entry, applied, refused or duplicate alike', () => {
    const sent = [note('n1', 'r1'), position('p1', 'r1'), note('n2', 'r2')];
    const outcome = applySyncResults(sent, [
      { clientId: 'n1', status: 'applied', code: null, message: null, note: null },
      { clientId: 'p1', status: 'duplicate', code: null, message: null, note: null },
      { clientId: 'n2', status: 'refused', code: 'invalid_input', message: 'That word is not allowed.', note: null },
    ]);
    expect(outcome.settled).toEqual(['n1', 'p1', 'n2']);
    expect(outcome.touchedRecordings).toEqual(['r1', 'r2']);
    expect(outcome.droppedPositions).toBe(0);
  });

  it('keeps an unanswered entry for the next flush', () => {
    const outcome = applySyncResults([note('n1', 'r1'), note('n2', 'r1')], [
      { clientId: 'n1', status: 'applied', code: null, message: null, note: null },
    ]);
    expect(outcome.settled).toEqual(['n1']);
  });

  it('returns a refused note as a draft with the reason, unless the teaching is gone', () => {
    const outcome = applySyncResults([note('n1', 'r1'), note('n2', 'r2')], [
      { clientId: 'n1', status: 'refused', code: 'invalid_input', message: 'That word is not allowed.', note: null },
      { clientId: 'n2', status: 'refused', code: 'not_found', message: 'This teaching is no longer available.', note: null },
    ]);
    expect(outcome.refusedNotes).toEqual([
      {
        recordingId: 'r1',
        text: 'Note n1',
        visibility: 'private',
        anchorMs: 12_000,
        message: 'That word is not allowed.',
        recordingGone: false,
      },
      {
        recordingId: 'r2',
        text: 'Note n2',
        visibility: 'private',
        anchorMs: 12_000,
        message: 'This teaching is no longer available.',
        recordingGone: true,
      },
    ]);
  });

  it('counts a refused position and keeps no draft for it', () => {
    const outcome = applySyncResults([position('p1', 'r1')], [
      { clientId: 'p1', status: 'refused', code: 'not_found', message: 'There is no such teaching.', note: null },
    ]);
    expect(outcome.droppedPositions).toBe(1);
    expect(outcome.refusedNotes).toEqual([]);
    expect(outcome.touchedRecordings).toEqual([]);
  });

  it('ignores an answer about an entry it did not send', () => {
    const outcome = applySyncResults([note('n1', 'r1')], [
      { clientId: 'stranger', status: 'applied', code: null, message: null, note: null },
    ]);
    expect(outcome.settled).toEqual([]);
  });
});
