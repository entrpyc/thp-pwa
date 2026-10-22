/**
 * **The typed confirmation** both deletion screens ask for beside the password (operator decision
 * for [3.1.8](docs/project/prd.md), chosen over a second press).
 *
 * The password proves the person; this proves the intention. A password field can be filled by a
 * password manager with one keystroke, which is exactly the one keystroke a deletion must not be —
 * so the button stays locked until this word has been typed by hand. One word, the plainest one,
 * rather than the account's address: the address is already on the screen, and copying a thing
 * from the screen into a field is not a decision.
 *
 * Case and surrounding spaces are forgiven. A phone that capitalises the first letter of a field
 * is not a person changing their mind.
 */
export const DELETION_CONFIRMATION_WORD = 'delete';

export function isDeletionConfirmed(typed: string): boolean {
  return typed.trim().toLowerCase() === DELETION_CONFIRMATION_WORD;
}
