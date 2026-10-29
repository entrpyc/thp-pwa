/**
 * **The word list behind the note filter** — the floor, and deliberately nothing more.
 *
 * Apple guideline 1.2 asks a product with user-generated content for "a method for filtering
 * objectionable material". This is that method's vocabulary: a short list of English and Bulgarian
 * words that have no innocent use in a study note, matched as whole words by `filter.ts`. The
 * group writes in both languages, so the Bulgarian half is held to the same bar as the English one:
 * hard profanity and slurs only, nothing a verse or an honest sentence could contain. Bulgarian is
 * inflected, so a word is listed in each form that is itself a whole word; the filter does not stem.
 *
 * **It is a floor, not moderation.** A member who wants to be unkind can be unkind without any of
 * these words, and a list that tried to anticipate that would refuse honest notes long before it
 * stopped a determined one. Moderation is the report path and the admin's delete
 * ([3.12.10](docs/project/prd.md)); this list only keeps the most obvious things from landing at
 * all, so an admin never has to see them.
 *
 * **What is kept out of the list, and why:**
 *
 * - Words with ordinary meanings (`ass` the animal, `cock` the bird, `damn`, `hell` — a study
 *   group will quote scripture that uses them). Refusing a verse is worse than admitting a mild word.
 * - Anything matched as a substring. `filter.ts` matches whole words only, so a list entry can
 *   never catch a word that contains it — which is why the list may hold short entries at all.
 * - Spelling variants and leetspeak. Chasing them makes the list grow without bound, and a member
 *   who bothers to evade is a member the report path exists for.
 *
 * Lower-case, one word per entry, no spaces; `filter.ts` lower-cases the note before comparing.
 * Adding a word is one line here and a unit test's expectation; nothing else reads this file.
 */
export const BLOCKED_WORDS: readonly string[] = [
  // Hard profanity with no other reading.
  'fuck',
  'fucking',
  'fucker',
  'motherfucker',
  'shit',
  'bullshit',
  'cunt',
  'cunts',
  'wanker',
  'twat',
  'asshole',
  'assholes',
  'bitch',
  'bitches',
  'whore',
  'slut',
  // Slurs. Each is only ever an insult.
  'nigger',
  'niggers',
  'nigga',
  'faggot',
  'faggots',
  'fag',
  'fags',
  'retard',
  'retards',
  'retarded',
  'tranny',
  'kike',
  'spic',
  'chink',
  'paki',
  // Bulgarian. Hard profanity, in the forms members actually type.
  'еба',
  'ебах',
  'ебал',
  'ебала',
  'ебат',
  'ебати',
  'ебаси',
  'ебаваш',
  'шибан',
  'шибана',
  'шибано',
  'шибани',
  'путка',
  'путки',
  'пичка',
  'пички',
  'курва',
  'курви',
  'курво',
  'лайно',
  'лайна',
  'лайнар',
  'лайнари',
  // Bulgarian slurs. Each is only ever an insult.
  'педал',
  'педали',
  'педераст',
  'педерасти',
  'педерас',
];
