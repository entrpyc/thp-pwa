/**
 * The negative control for tools/note-privacy.ts. A second statement of the private-note condition,
 * in both spellings this codebase writes queries in and over both halves of it — the Drizzle
 * helpers and raw SQL, `note.visibility` and `note.author_id`.
 *
 * This is the shape a later read path would take if somebody wrote its own privacy rule beside a
 * route instead of asking the one module that owns it — which is exactly how a member's private
 * note reaches somebody else.
 */
import { eq, or, sql } from 'drizzle-orm';

declare const note: { readonly visibility: unknown; readonly authorId: unknown };
declare const me: string;

export const secondCondition = or(eq(note.visibility, 'public'), eq(note.authorId, me));

export const rawCondition = sql`
  select id from note where visibility = 'public' or author_id = ${me}
`;
