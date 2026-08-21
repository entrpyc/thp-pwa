/**
 * The password rules. **One statement of them for the whole product** — the seed-admin command,
 * the invitation-accept screen and (from ticket 4) password reset all read this module, so the three
 * cannot disagree about what a usable password is.
 *
 * It lives in `shared` rather than in the API because the accept screen has to be able to *show*
 * the rule before someone fails it. A rule the person only learns by being refused is an exam.
 */

/** Long enough that argon2's cost matters. Nothing shorter is worth an account. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** What the screen prints under the field, before anything has been typed. */
export const PASSWORD_RULE_TEXT = `At least ${MINIMUM_PASSWORD_LENGTH} characters. Anything you can remember and nobody can guess.`;

export interface PasswordCheckContext {
  /** The address the password will belong to. A password that *is* the address is not one. */
  readonly email?: string;
}

/**
 * `null` when the password is acceptable, otherwise one sentence saying what is wrong with it.
 *
 * The sentence is written to be shown to the person choosing the password, and it never repeats
 * what they typed — a refusal that echoes a password puts it in a log or a screenshot.
 */
export function checkPassword(
  password: string,
  context: PasswordCheckContext = {},
): string | null {
  if (password === '') return 'Choose a password.';
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return `That is ${password.length} characters; passwords need at least ${MINIMUM_PASSWORD_LENGTH}.`;
  }
  if (password.trim() === '') return 'That is only spaces. Choose a password.';
  if (password.toLowerCase().includes('password')) {
    return 'That contains the word "password". Pick something a list would not.';
  }
  const email = context.email?.trim().toLowerCase();
  if (email !== undefined && email !== '' && password.toLowerCase() === email) {
    return 'That is your email address. Pick something else.';
  }
  return null;
}
