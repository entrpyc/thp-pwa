/**
 * **The three public documents the app stores require**, by path.
 *
 * Apple guideline 5.1.1(i) and Google's listing rules each want a privacy policy a reviewer can
 * open from the store page and a member can open from inside the app; Apple 1.2 wants published
 * contact details; Google's user-generated-content policy wants terms a member accepts before they
 * post. The pages are under `packages/web/src/app/(public)`, and their paths live here rather than
 * beside them because more than the pages will cite them: the legal-links row draws them, the
 * store consoles are given them, and the terms-acceptance control (a later ticket) has to point at
 * the same `/terms` the sign-in footer does. A path spelled in two places is a path that can
 * drift from itself.
 *
 * Page paths, on the web origin rather than under the API prefix — the same distinction
 * `SIGN_UP_PAGE_PATH` draws in auth.ts.
 */
export const PRIVACY_PAGE_PATH = '/privacy';
export const TERMS_PAGE_PATH = '/terms';
export const SUPPORT_PAGE_PATH = '/support';

/**
 * **Where to write to the operator.** Published on `/support` and in the privacy policy as the way
 * to ask anything the pages do not answer — a data request, a deletion request, a complaint — and
 * it is the same mailbox a bug report from the in-app form lands in (`FEEDBACK_MAIL_TO`'s default),
 * so a member who writes and a member who presses the form reach the same person. Named here, in
 * the vocabulary, so a page and the mail layer cannot publish two different addresses.
 */
export const SUPPORT_EMAIL = 'asen.angelov@indepthwebsolutions.com';

/**
 * The legal entity the pages name as the operator and data controller. A Bulgarian single-member
 * limited company (EOOD), which is why the terms choose Bulgarian law.
 */
export const OPERATOR_NAME = 'Indepth Solutions EOOD';

// =================================================================================================
// Terms acceptance (Google Play UGC policy: a member accepts the terms before they post)
// =================================================================================================

/**
 * **Which terms a member has agreed to**, as the calendar day the terms page says it was last
 * updated — `YYYY-MM-DD`, the same spelling `PublicDocument`'s `updatedOn` takes.
 *
 * A date rather than a counter, by operator decision: the terms page already carries exactly one
 * date, the member reads that date at the top of the page they are accepting, and storing the same
 * string on the account means "which terms did they agree to" is answered by a value a person can
 * read without a lookup. Changing the terms is one edit here; the page's `updatedOn` should read
 * this constant rather than restate it (the terms page is owned by another branch, so at the time
 * of writing the two are spelled twice and have to be kept equal by hand — see the merge note).
 *
 * The comparison is **string equality**, not ordering. An account whose stored version is not this
 * one — older, or null because the account predates the column or came through an invitation —
 * is asked again before its next note. A `YYYY-MM-DD` string also orders lexically, which is why
 * the format is fixed by the pattern below, but nothing depends on that today.
 */
export const TERMS_VERSION = '2026-10-22';

/** The one shape a terms version may take. Refusing anything else keeps the column readable. */
export const TERMS_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a stored acceptance is good for posting today. `null` is "never accepted", and an
 * acceptance of any other version is stale: both ask the member again.
 */
export function termsAcceptanceIsCurrent(accepted: string | null | undefined): boolean {
  return accepted === TERMS_VERSION;
}

/**
 * `PUT /api/v1/users/me/terms` — the signed-in account accepts the current terms. `me` rather than
 * an id in the path, as the analytics and avatar routes are: the only acceptance anybody may
 * record is their own.
 */
export const TERMS_ACCEPTANCE_PATH = '/users/me/terms';

/**
 * Body of `PUT /api/v1/users/me/terms`, and of the acceptance half of `POST /api/v1/auth/sign-up`.
 *
 * The version is **sent by the client, and must equal {@link TERMS_VERSION}**. A body that only
 * said "yes" would let a screen built against last month's terms record acceptance of this
 * month's; sending the version the screen showed is what makes a stale screen a refusal rather
 * than a wrong row.
 */
export interface TermsAcceptanceRequest {
  readonly termsVersion: string;
}

/** Payload of `PUT /api/v1/users/me/terms`: what the account now holds. */
export interface TermsAcceptancePayload {
  readonly termsVersion: string;
  /** ISO 8601. */
  readonly acceptedAt: string;
}

/**
 * What a member reads when a note is refused because their acceptance is missing or stale. The API
 * refuses with it and the composer prints it over the prompt, so the two cannot say different
 * things about why the note did not save.
 */
export const TERMS_REQUIRED_MESSAGE =
  'Before you post, please read and accept the terms of use. Your note is still here.';
