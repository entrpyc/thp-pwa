/**
 * **What a report is, said once for the whole repository.**
 *
 * A member presses *Report a bug* in the navigation menu, types a title and a description, says
 * which of the two things it is, and it arrives in a maintainer's inbox. Nothing is stored: there
 * is no table behind this and no screen that lists past reports, so **the message is the record**.
 * That is the whole design, and everything below follows from it.
 *
 * Three things live here rather than beside the route, because the form, the API and the email
 * template each have to agree about them:
 *
 * 1. **The two kinds**, and the words they are printed with. The toggle, the subject line and the
 *    body all read {@link feedbackKindLabel} rather than spelling "Bug report" three times, so a
 *    report cannot arrive labelled one thing on the button and another in the inbox.
 * 2. **The two ceilings.** The form disables its own submit against them and the API refuses
 *    against them independently — the standing rule that a client-side limit is a courtesy and the
 *    server's is the limit.
 * 3. **The path**, so the form cannot ask a URL the route does not answer.
 */

/**
 * Which of the two a report is.
 *
 * Two values and not three. "Question" and "feature request" both sound like they belong, and both
 * would be a category a reader has to act on differently without anything here telling them how —
 * whereas the split that matters to whoever opens the inbox is *is something broken*, which decides
 * whether it is read now or read later.
 */
export const FEEDBACK_KINDS = ['bug', 'feedback'] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

/**
 * How each kind is written wherever a person reads it — the toggle, the subject line, the body.
 *
 * A record rather than a `switch`, so adding a kind is a compile error in one place instead of a
 * silent fallthrough to the wrong word.
 */
const FEEDBACK_KIND_LABELS: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Bug report',
  feedback: 'Feedback',
};

export function feedbackKindLabel(kind: FeedbackKind): string {
  return FEEDBACK_KIND_LABELS[kind];
}

/** The hint under the toggle. Here beside the labels so the pair cannot drift apart. */
const FEEDBACK_KIND_HINTS: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Something is broken or behaving in a way it should not.',
  feedback: 'An idea, a suggestion, or something that could be better.',
};

export function feedbackKindHint(kind: FeedbackKind): string {
  return FEEDBACK_KIND_HINTS[kind];
}

/**
 * The most a title may be.
 *
 * A subject line, not a description — long enough to say what broke, short enough that it does not
 * arrive truncated by the recipient's mail client and unreadable in a notification preview.
 */
export const MAX_FEEDBACK_TITLE_LENGTH = 120;

/**
 * The most a description may be. Counted in characters rather than bytes, exactly as a note's
 * ceiling is, so a report written in any script gets the same room.
 */
export const MAX_FEEDBACK_DESCRIPTION_LENGTH = 4_000;

/** Where a member writes one, on the web origin rather than under the API prefix. */
export const FEEDBACK_PAGE_PATH = '/feedback';

/** Where it is sent, relative to the `/api/v1` prefix. One route, one method. */
export const FEEDBACK_PATH = '/feedback';

/** Body of `POST /api/v1/feedback`. */
export interface SubmitFeedbackRequest {
  readonly kind: FeedbackKind;
  readonly title: string;
  readonly description: string;
}

/**
 * Payload of `POST /api/v1/feedback`.
 *
 * One field, and deliberately not an id: nothing is stored, so there is no id to hand back and no
 * second request that could ask about one. A member who wants a copy of what they sent has the
 * screen they just typed it into.
 */
export interface FeedbackSubmittedPayload {
  readonly submitted: true;
}
