import { MAX_DISPLAY_NAME_LENGTH } from '@thp/shared';

/**
 * The name a new account starts life with, derived from its address.
 *
 * **Two flows create accounts and neither asks for a name**: accepting an invitation asks for a
 * password and nothing else, because one field is the whole point of that screen, and signing up
 * asks for the two things that *are* the credential. So the local part of the address stands in
 * until its owner edits it (docs/project/prd.md, 3.1.12) — and it stands in the same way for both,
 * which is why this lives here rather than in either flow's service.
 *
 * The result is trimmed to the ceiling the product states rather than checked against it: this is
 * a placeholder the product chose, not something a person typed, and refusing to create an account
 * because somebody's email address is long would be a refusal about the wrong thing.
 */
export function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._+-]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return (words.length === 0 ? email : words.join(' ')).slice(0, MAX_DISPLAY_NAME_LENGTH);
}
