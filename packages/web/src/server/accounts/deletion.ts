import {
  deleteUserAccount,
  listPrivateNoteImageKeysOfAuthor,
  type AccountDeletion,
  type UserRow,
} from '@thp/db';
import type { AccountDeletedPayload, DeleteOwnAccountRequest } from '@thp/shared';
import { mediaStore } from '@thp/media';
import { ApiError } from '@/server/api/errors';
import { verifyPassword } from '@/server/auth/password';
import { toActor, type Actor } from '@/server/auth/policy';
import { audit } from '@/server/observability/audit';
import { logger } from '@/server/observability/logger';
import { deleteNoteImageObjects } from '@/server/notes/images';

/**
 * **A member deletes their own account** ([3.1.8](docs/project/prd.md); Apple 5.1.1(v) and
 * Google Play's account-deletion policy, both of which say deactivation is not enough).
 *
 * Two doors, one erasure. {@link deleteOwnAccount} is the signed-in door behind
 * `DELETE /api/v1/users/me`; the token door — a link mailed to the address from the public page,
 * for somebody who no longer has the app — is `server/account-deletion/service.ts`, and it ends in
 * the same {@link eraseAccount}. Both require the **current password**: a session cookie on a
 * shared tablet, or a link in a forwarded email, is not the person, and a deletion is the one
 * action in the product that cannot be undone by anybody.
 *
 * What the erasure does to each table is packages/db/src/README.md; what this module adds is the
 * order of the three things the database cannot do for itself:
 *
 * 1. **The password is verified before anything is written.** A wrong one answers
 *    `password_incorrect` and changes nothing.
 * 2. **The database erasure runs**, behind the last-admin guard deactivation uses. The last
 *    active admin is refused with `last_admin`, exactly as if an admin had tried to deactivate
 *    them — the fix is to promote somebody first, and the message says so.
 * 3. **The avatar object is deleted after the transaction commits**, because the store is not
 *    transactional: a delete that ran first and a transaction that then rolled back would leave a
 *    person with an account and no picture, which is the wrong failure. The other order can leave
 *    an orphan object if the store is down at that instant, and that failure is logged at `error`
 *    with the key so an operator can finish by hand — the row that pointed at it is gone, so
 *    nothing can ever mint a URL for it again.
 *
 * **One audit line, `account.delete`**, with the actor fields every audit line carries. The actor
 * *is* the person being deleted, so the line records their id and address: that is the record of
 * who removed what (3.12.10's rule, applied to an account), and it is the one place the address
 * outlives the row. packages/db/src/README.md says so where the privacy policy's author will read
 * it.
 */

/** The most a field can be before we stop reading it. A password is a passphrase, not a payload. */
const MAX_FIELD_LENGTH = 512;

export async function deleteOwnAccount(
  actor: Actor,
  body: unknown,
  current: UserRow,
): Promise<AccountDeletedPayload> {
  const password = parsePassword(body);
  await requireCurrentPassword(actor, current, password, 'account.delete');
  return eraseAccount(current, 'session');
}

/** The body of either door: the password, read before anything else is looked at. */
export function parsePassword(body: unknown): string {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with your current password.');
  }
  const { password } = body as Partial<DeleteOwnAccountRequest>;
  if (typeof password !== 'string' || password === '' || password.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Confirm with your current password.');
  }
  return password;
}

/**
 * The confirmation. Verified against the row as it is now rather than against the session's copy,
 * so a password changed on another device a moment ago is the one that counts.
 */
export async function requireCurrentPassword(
  actor: Actor,
  current: UserRow,
  password: string,
  action: string,
): Promise<void> {
  if (await verifyPassword(current.passwordHash, password)) return;
  logger.warn('account.delete.refused', {
    ...audit(actor, action, `account:${actor.id}`),
    reason: 'password-incorrect',
    code: 'password_incorrect',
  });
  throw ApiError.passwordIncorrect();
}

/**
 * The erasure, once the person has proved it is them. `via` says which door, for the log.
 */
export async function eraseAccount(
  current: UserRow,
  via: 'session' | 'token',
): Promise<AccountDeletedPayload> {
  const actor = toActor(current);
  // Read before the erasure hard-deletes the private notes: afterwards there is nothing to find
  // the objects by. Public notes keep their pictures, as they keep their words (3.1.10).
  const privateImageKeys = await listPrivateNoteImageKeysOfAuthor(current.id).catch(() => [] as string[]);
  const result = await deleteUserAccount(current.id);

  if (result.outcome === 'no-such-account') {
    // The row went between the password check and the lock — a second device finishing first.
    throw ApiError.notFound('There is no such account.');
  }
  if (result.outcome === 'last-admin') {
    logger.warn('account.delete.refused', {
      ...audit(actor, 'account.delete', `account:${actor.id}`),
      reason: 'last-active-admin',
      code: 'last_admin',
      via,
    });
    throw ApiError.lastAdmin(
      'You are the only active admin. Make another member an admin first, then delete your account.',
    );
  }
  if (result.outcome === 'unchanged') {
    // Unreachable: the erasure returns a record or throws. Stated so a future change cannot fall
    // through it silently.
    throw new Error('deleteUserAccount reported unchanged');
  }

  const deletion: AccountDeletion = result.value;
  logger.info('account.delete', {
    ...audit(actor, 'account.delete', `account:${actor.id}`),
    via,
    placeholderId: deletion.placeholderId,
    retainedPublicNotes: deletion.retainedPublicNotes,
    retainedPublicReplies: deletion.retainedPublicReplies,
    deletedPrivateNotes: deletion.deletedPrivateNotes,
    anonymisedNotifications: deletion.anonymisedNotifications,
    forgottenInvitations: deletion.forgottenInvitations,
    retainedBlocks: deletion.retainedBlocks,
    avatarKey: current.avatarKey,
  });

  await deleteAvatarObject(actor, current.avatarKey);
  await deleteNoteImageObjects(actor, privateImageKeys);

  return {
    deleted: true,
    deletedAt: deletion.deletedAt.toISOString(),
    retained: {
      publicNotes: deletion.retainedPublicNotes,
      publicReplies: deletion.retainedPublicReplies,
    },
  };
}

/**
 * After the commit, best effort, loud on failure. The key is in the line so the object can be
 * removed by hand; nothing else in the product will ever reference it again.
 */
async function deleteAvatarObject(actor: Actor, avatarKey: string | null): Promise<void> {
  if (avatarKey === null) return;
  try {
    await mediaStore().deleteAvatar(avatarKey);
    logger.info('account.delete.avatar', {
      ...audit(actor, 'account.delete', `account:${actor.id}`),
      mediaKey: avatarKey,
    });
  } catch (cause) {
    logger.error('account.delete.avatar-orphaned', {
      ...audit(actor, 'account.delete', `account:${actor.id}`),
      mediaKey: avatarKey,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
