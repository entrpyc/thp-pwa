/**
 * **The posting rules, as a list rather than as prose.**
 *
 * Google's user-generated-content policy wants a member to accept the rules before they post, and
 * the control that asks (a later ticket) has to show the same rules `/terms` publishes — the same
 * words, in the same order — or a member accepts one thing and is held to another. So the rules
 * are a constant the page renders and the control will render, not sentences the page owns.
 *
 * Each rule is one sentence a person can read in a dialog. The reasons are on the terms page; the
 * rules themselves carry none, because the moment of acceptance is not the moment for an
 * argument. Plain strings rather than nodes so the acceptance control can render them however it
 * draws a list, and so a test can compare them without rendering anything.
 */
export const POSTING_RULES: readonly string[] = [
  'Write about the teaching. A note belongs to the moment of the recording it sits on.',
  'Be kind. No insults, harassment, threats, or contempt for anyone, inside the group or outside it.',
  'Nothing unlawful, sexual, or violent, and nothing that urges harm to any person or group.',
  'Respect privacy. Do not post personal details about others, or private conversations, without their consent.',
  'Your own words. Do not paste text you have no right to share, and do not advertise or spam.',
  'Be yourself. Your display name is your own name or one the group knows you by, never somebody else’s.',
];
