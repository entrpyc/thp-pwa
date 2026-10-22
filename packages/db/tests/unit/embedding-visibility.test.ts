import { describe, expect, it } from 'vitest';
import { EMBEDDING_SOURCE_KINDS } from '@thp/shared';
import { isEmbeddingVisibleTo, type EmbeddingVisibilityFacts } from '../../src/visibility';

/**
 * **The embedding visibility rule, over every combination** ([3.10.9](docs/project/prd.md),
 * NFR 6.7) — a member's results are published content plus their own private notes, and never
 * another member's private content or any unpublished draft.
 *
 * The pure spelling of the rule is what is under test here; the SQL spelling is held to it in
 * packages/db/tests/integration/embeddings.test.ts against seeded rows. Two spellings that must
 * agree is the cost of a rule that has to be both unit-testable and a `where` clause, and the
 * integration suite is what makes that cost a test rather than a promise.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEBODY_ELSE = '22222222-2222-4222-8222-222222222222';
const LIVE = new Date('2026-10-01T10:00:00Z');

function facts(overrides: Partial<EmbeddingVisibilityFacts> = {}): EmbeddingVisibilityFacts {
  return {
    sourceKind: 'segment',
    recordingPublishedAt: LIVE,
    summaryPublishedAt: null,
    ownerUserId: null,
    ...overrides,
  };
}

describe('rows of a published recording', () => {
  it.each(EMBEDDING_SOURCE_KINDS.filter((kind) => kind !== 'summary' && kind !== 'series'))(
    'a %s of a published recording is visible to any member',
    (kind) => {
      expect(isEmbeddingVisibleTo(ME, facts({ sourceKind: kind }))).toBe(true);
      expect(isEmbeddingVisibleTo(SOMEBODY_ELSE, facts({ sourceKind: kind }))).toBe(true);
    },
  );

  it('a published summary of a published recording is visible — both gates open', () => {
    expect(
      isEmbeddingVisibleTo(ME, facts({ sourceKind: 'summary', summaryPublishedAt: LIVE })),
    ).toBe(true);
  });
});

describe('unpublished recordings (3.10.9 — "never any unpublished draft")', () => {
  it.each(EMBEDDING_SOURCE_KINDS.filter((kind) => kind !== 'series'))(
    'a %s of an unpublished recording is visible to nobody',
    (kind) => {
      const draft = facts({
        sourceKind: kind,
        recordingPublishedAt: null,
        summaryPublishedAt: LIVE,
      });
      expect(isEmbeddingVisibleTo(ME, draft)).toBe(false);
      expect(isEmbeddingVisibleTo(SOMEBODY_ELSE, draft)).toBe(false);
    },
  );

  it('hides even the member’s own private note when the teaching it is on is unpublished', () => {
    // The notes read path refuses an unpublished recording outright; search must not be the one
    // door through which a taken-down teaching's notes stay reachable.
    expect(
      isEmbeddingVisibleTo(
        ME,
        facts({ sourceKind: 'note', recordingPublishedAt: null, ownerUserId: ME }),
      ),
    ).toBe(false);
  });
});

describe('draft summaries (3.6.12 — the second gate)', () => {
  it('a summary returned to draft on a live recording is visible to nobody', () => {
    const returned = facts({ sourceKind: 'summary', summaryPublishedAt: null });
    expect(isEmbeddingVisibleTo(ME, returned)).toBe(false);
    expect(isEmbeddingVisibleTo(SOMEBODY_ELSE, returned)).toBe(false);
  });

  it('the summary gate is read only for a summary — a segment ignores it', () => {
    expect(isEmbeddingVisibleTo(ME, facts({ sourceKind: 'segment', summaryPublishedAt: null }))).toBe(
      true,
    );
  });
});

describe('private notes (3.12.3, NFR 6.7)', () => {
  it('the owner sees their own private note', () => {
    expect(isEmbeddingVisibleTo(ME, facts({ sourceKind: 'note', ownerUserId: ME }))).toBe(true);
  });

  it('another member never sees it — whoever they are', () => {
    expect(isEmbeddingVisibleTo(SOMEBODY_ELSE, facts({ sourceKind: 'note', ownerUserId: ME }))).toBe(
      false,
    );
  });

  it('a public note has no owner on its row and is visible to everyone', () => {
    expect(isEmbeddingVisibleTo(SOMEBODY_ELSE, facts({ sourceKind: 'note', ownerUserId: null }))).toBe(
      true,
    );
  });
});

describe('rows that belong to no recording', () => {
  it('a series row is visible to nobody until the scope that writes it says what its gate is', () => {
    // Stated so a kind arriving later cannot be visible by default — the failure this product
    // cannot take back is something nobody published becoming readable.
    expect(
      isEmbeddingVisibleTo(ME, facts({ sourceKind: 'series', recordingPublishedAt: null })),
    ).toBe(false);
  });
});
