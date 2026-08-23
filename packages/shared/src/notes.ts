/**
 * **What a note is, said once for the whole repository.**
 *
 * Two things live here because the database, the API and the composer each have to agree about
 * them and the price of disagreement is a member losing what they wrote:
 *
 * 1. **The two visibilities.** `packages/db/src/schema.ts` derives its `note_visibility` enum from
 *    {@link NOTE_VISIBILITIES} rather than restating the values beside it, which is what
 *    tests/guards/domain-declarations.test.ts already enforces for `ROLES` and `PIPELINE_STEPS`.
 * 2. **The character ceiling.** The column's check constraint is derived from
 *    {@link MAX_NOTE_LENGTH}, so a note the composer would accept and the database would refuse is
 *    not a state this product can reach.
 *
 * The wire contract — request and payload shapes — arrives with the routes that carry it.
 */

/**
 * Who may read a note.
 *
 * `private` is the author alone; `public` is everyone in the group. Chosen at creation and
 * immutable afterwards (active-scope prd 3.1.5) — no update path writes this column, which is why
 * there is no third value for "was public, now isn't".
 */
export const NOTE_VISIBILITIES = ['private', 'public'] as const;

export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

/**
 * The most a note may be (active-scope prd 3.1.6).
 *
 * Counted in characters, which is what the composer counts down from and what
 * `char_length` measures — not bytes, so a note in any script gets the same room.
 */
export const MAX_NOTE_LENGTH = 1_000;
