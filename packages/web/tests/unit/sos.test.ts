import { describe, expect, it } from 'vitest';
import {
  MAX_OPEN_SOS_PER_MEMBER,
  NOTIFICATION_CATEGORY_OF_KIND,
  SOS_URGENCIES,
  SOS_URGENCY_MEANING,
  compareSosSignals,
  isSosUrgency,
  sosPagePath,
  sosRaisedNotificationTitle,
  sosReplyNotificationTitle,
  sosUrgencyRank,
} from '@thp/shared';

/**
 * **The SOS vocabulary** ([3.16](docs/project/prd.md)), asserted with no browser and no database:
 * the four colours in the PRD's order and with its words, the board's order as a comparator, the
 * cap, and the two sentences the bell prints.
 */

describe('the four urgencies', () => {
  it('are the PRD table, most urgent first, each with its meaning', () => {
    // Not restated as a tuple — the domain-declarations guard would read that as a second copy.
    expect(SOS_URGENCIES).toHaveLength(4);
    expect(SOS_URGENCIES[0]).toBe('red');
    expect(SOS_URGENCIES[3]).toBe('green');
    expect(SOS_URGENCY_MEANING.red).toContain('Immediate crisis');
    expect(SOS_URGENCY_MEANING.green).toContain('no urgency');
    expect(SOS_URGENCIES.map(sosUrgencyRank)).toEqual([0, 1, 2, 3]);
  });

  it('refuse anything else', () => {
    expect(isSosUrgency('red')).toBe(true);
    expect(isSosUrgency('purple')).toBe(false);
    expect(isSosUrgency(null)).toBe(false);
  });
});

describe('the board`s order (3.16.4)', () => {
  it('sorts by urgency first, then most recently raised', () => {
    const signals = [
      { id: 'old-green', urgency: 'green', raisedAt: '2026-10-01T10:00:00.000Z' },
      { id: 'new-green', urgency: 'green', raisedAt: '2026-10-02T10:00:00.000Z' },
      { id: 'old-red', urgency: 'red', raisedAt: '2026-09-01T10:00:00.000Z' },
      { id: 'yellow', urgency: 'yellow', raisedAt: '2026-10-03T10:00:00.000Z' },
    ] as const;
    expect([...signals].sort(compareSosSignals).map((one) => one.id)).toEqual([
      'old-red',
      'yellow',
      'new-green',
      'old-green',
    ]);
  });
});

describe('the cap and the sentences', () => {
  it('keeps the channel an emergency channel with a cap that nobody hits by hand', () => {
    expect(MAX_OPEN_SOS_PER_MEMBER).toBe(10);
  });

  it('names the member and the colour when a signal is raised, and the member on a reply', () => {
    expect(sosRaisedNotificationTitle('Ana', 'red')).toBe('Ana raised a red prayer request');
    expect(sosReplyNotificationTitle('Ben')).toBe('Ben replied to your prayer request');
  });

  it('lands a notification on the signal`s page and files both kinds under one switch (3.17.14)', () => {
    expect(sosPagePath('abc')).toBe('/prayer-requests/abc');
    expect(NOTIFICATION_CATEGORY_OF_KIND.sos_raised).toBe('sos');
    expect(NOTIFICATION_CATEGORY_OF_KIND.sos_reply).toBe('sos');
  });
});
