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
