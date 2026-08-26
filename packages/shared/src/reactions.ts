/**
 * **The six reactions, said once for the whole product** (active-scope prd 3.4.1, active-scope
 * architecture § 4.5).
 *
 * Its own module rather than a section of `notes.ts`, for one reason that is already visible in the
 * full scope: SOS acknowledgement ([3.16.5](docs/project/prd.md)) is the same 🙏 that is in this
 * list, and a vocabulary that lives inside the notes contract would have to be imported *from* the
 * notes contract by a feature that has nothing to do with notes.
 *
 * **The glyph is the identity.** `note_reaction.emoji` stores the character itself rather than a
 * key, which is what makes scope prd 3.4.2 true: a reaction stored under an emoji
 * that later leaves this list still renders as what it always was and still counts, and is simply
 * no longer offered. {@link reactionName} is the only thing that knows the list, and it answers for
 * a departed glyph by handing back the glyph.
 *
 * The accessible name travels beside the glyph because a bare emoji is unreadable to a screen
 * reader (scope prd 5.4.1) and because the picker labels its six controls with
 * exactly these words (scope prd 5.4.2).
 */

/**
 * The vocabulary. Fixed, six, and the same everywhere — there is no free entry and no per-recording
 * or per-member customisation (scope prd 3.4.1).
 *
 * Registered in `tools/domain-declarations.ts`, so a second copy of these six anywhere in the
 * repository fails the build the way a restated `ROLES` already does.
 */
export const REACTIONS = [
  { emoji: '🙏', name: 'praying' },
  { emoji: '❤️', name: 'loved' },
  { emoji: '🔥', name: 'convicting' },
  { emoji: '💡', name: 'insight' },
  { emoji: '👏', name: 'encouraged' },
  { emoji: '😢', name: 'moved' },
] as const;

export type Reaction = (typeof REACTIONS)[number];

/** One of the six glyphs, as the vocabulary spells it — variation selector included. */
export type ReactionEmoji = Reaction['emoji'];

/**
 * Whether this is one of the six, compared against **the exact string** the vocabulary carries.
 *
 * That exactness is the point: `❤` and `❤️` are different strings, and a service that accepted
 * either would store both and count them as two different reactions. The API refuses anything that
 * is not character-for-character one of the six, so only the six ever land
 * (scope plan 4.2.4).
 */
export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && REACTIONS.some((one) => one.emoji === value);
}

/**
 * What a screen reader says for a glyph — its name while it is in the set, and **the glyph itself**
 * once it is not.
 *
 * The fallback is scope prd 3.4.2 in one line: a member's past response is not
 * rewritten by a product decision taken after it, so a departed emoji is still labelled by
 * something rather than announced as nothing.
 */
export function reactionName(emoji: string): string {
  return REACTIONS.find((one) => one.emoji === emoji)?.name ?? emoji;
}
