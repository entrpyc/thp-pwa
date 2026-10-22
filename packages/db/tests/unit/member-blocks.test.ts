import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { blockBetween, noBlockBetween } from '../../src/member-blocks';
import { note, noteReaction } from '../../src/schema';

/**
 * **The block predicate, as the SQL it spells** — with no database behind it.
 *
 * What the integration suite proves is that rows come and go as the rule says. What this file
 * pins is the *shape* of the rule, which is what a later caller — an SOS list, a push path — is
 * relying on when it writes `not(blockBetween(viewer, column))` and expects both directions:
 *
 * 1. It is one `exists` over `member_block`, so it is a condition and never a join that could
 *    multiply rows.
 * 2. **Both directions are in it.** The viewer as blocker with the column as blocked, *or* the
 *    column as blocker with the viewer as blocked — the whole of "mutual hiding" is that second
 *    half being present.
 * 3. The viewer travels as a parameter, never as text in the statement.
 * 4. The column is the caller's: the same fragment serves `note.author_id` and
 *    `note_reaction.user_id`, which is what makes it one predicate rather than one per table.
 */

const VIEWER = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();

function render(fragment: ReturnType<typeof blockBetween>) {
  const { sql, params } = dialect.sqlToQuery(fragment);
  return { sql: sql.replace(/\s+/g, ' '), params };
}

describe('blockBetween', () => {
  it('is one exists over member_block, parameterised on the viewer', () => {
    const { sql, params } = render(blockBetween(VIEWER, note.authorId));

    expect(sql.startsWith('exists (select 1 from "member_block"')).toBe(true);
    expect(sql.match(/\bexists\b/g)).toHaveLength(1);
    expect(sql).not.toContain('join');
    // The id reaches Postgres as a bound value, once per direction — never spliced into the text.
    expect(params).toEqual([VIEWER, VIEWER]);
    expect(sql).not.toContain(VIEWER);
  });

  it('states both directions — the viewer as blocker, and the viewer as blocked', () => {
    const { sql } = render(blockBetween(VIEWER, note.authorId));

    expect(sql).toContain(
      '("member_block"."blocker_id" = $1 and "member_block"."blocked_id" = "note"."author_id")',
    );
    expect(sql).toContain(
      '("member_block"."blocker_id" = "note"."author_id" and "member_block"."blocked_id" = $2)',
    );
    expect(sql).toContain(') or (');
  });

  it('serves any column that names a member, so one predicate covers every table', () => {
    const { sql } = render(blockBetween(VIEWER, noteReaction.userId));

    expect(sql).toContain('"member_block"."blocked_id" = "note_reaction"."user_id"');
    expect(sql).toContain('"member_block"."blocker_id" = "note_reaction"."user_id"');
  });

  it('is negated by noBlockBetween and nothing else changes', () => {
    const positive = render(blockBetween(VIEWER, note.authorId));
    const negative = render(noBlockBetween(VIEWER, note.authorId));

    expect(negative.sql).toBe(`not ${positive.sql}`);
    expect(negative.params).toEqual(positive.params);
  });
});
