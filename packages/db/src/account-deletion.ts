import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REMOVED_MEMBER_DISPLAY_NAME, ROLE } from '@thp/shared';
import { isAdmin, withLastAdminGuard, type Guarded, type UserRow } from './accounts';
import { getDatabase, queryable, type DatabaseHandle } from './client';
import { deleteEmbeddingsForSources } from './embeddings';
import { deleteInvitationsAddressedTo } from './invitations';
import { reassignBlocksAgainst } from './member-blocks';
import { reassignNotesOfDeletedAuthor } from './notes';
import { anonymiseNotificationsByActor } from './notifications';
import { user } from './schema';

/**
 * **Deleting an account** (docs/project/prd.md 3.1.8–3.1.10) — the erasure itself. What it does
 * to each table is the convention in README.md beside the schema; this file is the one place that
 * convention is executed, and the schema's `onDelete` clauses do most of the work.
 *
 * Its own module rather than more of `accounts.ts`, because it has to call into the notes,
 * notifications and invitations modules and `invitations.ts` already imports from `accounts.ts` —
 * an erasure written there would close an import cycle for the sake of a file name.
 */

/**
 * **A hash nothing verifies against.** argon2 refuses to parse it, `verifyPassword` turns that
 * refusal into `false`, and so a placeholder can never be signed in to by any password — without
 * the column having to become nullable for one kind of row.
 */
const UNVERIFIABLE_PASSWORD_HASH = '!removed';

/**
 * The address a placeholder carries. Unique per placeholder by the uuid, under a reserved TLD so
 * it can never be a deliverable address somebody later registers with (RFC 2606). The person's
 * real address appears nowhere on the row, which is what frees it for a new account.
 */
function placeholderEmail(): string {
  return `removed-${randomUUID()}@removed.invalid`;
}

/** What `deleteUserAccount` did — the facts the audit line and the confirmation screen are built from. */
export interface AccountDeletion {
  /** The row that was deleted, as it was. The service logs from it and never returns it. */
  readonly deleted: UserRow;
  /** The placeholder the person's public notes now name as their author. */
  readonly placeholderId: string;
  readonly deletedAt: Date;
  readonly retainedPublicNotes: number;
  readonly retainedPublicReplies: number;
  readonly deletedPrivateNotes: number;
  readonly anonymisedNotifications: number;
  readonly forgottenInvitations: number;
  /** Blocks other members held against the person, now held against the placeholder. */
  readonly retainedBlocks: number;
}

export type GuardedDeletion = Guarded<AccountDeletion>;

/**
 * **Delete an account** — behind the same last-admin guard deactivation uses
 * (docs/project/prd.md 3.1.11: *removal* or demotion of the last admin is refused, and this is
 * removal).
 *
 * The password check is the caller's; this is what happens once the person has proved it is them.
 * One transaction, in this order, and the order is the design:
 *
 * 1. **A placeholder row is written** — "Removed member", a sentinel address, an unverifiable
 *    hash, deactivated and `deleted_at` stamped. A fresh row per deleted account rather than one
 *    shared system account: two removed members in one thread stay two people, and a system
 *    account that must never sign in is a standing invariant somebody has to keep.
 * 2. **Notes move** (`notes.ts`): private ones are deleted, public ones and tombstones are
 *    re-pointed at the placeholder. This is what satisfies `note.author_id`'s `restrict` — the
 *    account row cannot go while anything it authored still names it, and that key is still
 *    what stops a hand at the database from taking a group's notes with one person's row.
 * 3. **The vectors of the deleted private notes go** in the same transaction, for the reason the
 *    note service gives when it deletes one: a vector is a copy of the words.
 * 4. **Other members' notifications stop naming the person** (`notifications.ts`).
 * 5. **Invitations addressed to the person are forgotten** (`invitations.ts`).
 * 6. **Blocks held against the person move to the placeholder** (`member-blocks.ts`), so the
 *    public notes that moved in step 2 stay hidden from every reader who had chosen not to see
 *    them. The person's own blocks go with the row: nobody is left for them to protect.
 * 7. **The account row is deleted**, and every foreign key to `user` does what the schema says:
 *    sessions, password resets, deletion requests, playback positions, onboarding completions,
 *    reactions, the person's own notifications and the vectors of their private notes cascade;
 *    `invited_by`, `deleted_by`, `pinned_by`, `reviewed_by`, `corrected_by_user_id`, `sent_by`,
 *    `actor_id`, `raised_by` and `created_by` set null. Nothing in this function names those
 *    tables, which is the point: a later table joins the convention by declaring its clause.
 *
 * The avatar object is not here. The store is not transactional, so the caller deletes it after
 * this commits, and the key it needs is on the returned row.
 */
export async function deleteUserAccount(
  id: string,
  handle: DatabaseHandle = getDatabase(),
): Promise<GuardedDeletion> {
  return withLastAdminGuard(
    id,
    // Removing an active admin's row removes an active admin, however the row is otherwise.
    (row) => row.deactivatedAt === null && isAdmin(row),
    async (tx, row) => {
      const db = queryable(tx);
      const deletedAt = new Date();

      const placeholders = await db
        .insert(user)
        .values({
          email: placeholderEmail(),
          passwordHash: UNVERIFIABLE_PASSWORD_HASH,
          displayName: REMOVED_MEMBER_DISPLAY_NAME,
          role: ROLE.member,
          deactivatedAt: deletedAt,
          deletedAt,
        })
        .returning({ id: user.id });
      const placeholder = placeholders[0];
      if (!placeholder) throw new Error('deleteUserAccount wrote no placeholder');

      const notes = await reassignNotesOfDeletedAuthor(id, placeholder.id, tx);
      await deleteEmbeddingsForSources('note', notes.deletedPrivateNoteIds, tx);
      const anonymisedNotifications = await anonymiseNotificationsByActor(
        id,
        REMOVED_MEMBER_DISPLAY_NAME,
        tx,
      );
      const forgottenInvitations = await deleteInvitationsAddressedTo(row.email, tx);
      const retainedBlocks = await reassignBlocksAgainst(id, placeholder.id, tx);

      const gone = await db.delete(user).where(eq(user.id, id)).returning({ id: user.id });
      if (gone.length === 0) throw new Error('deleteUserAccount deleted no row');

      return {
        deleted: row,
        placeholderId: placeholder.id,
        deletedAt,
        retainedPublicNotes: notes.retainedPublicNotes,
        retainedPublicReplies: notes.retainedPublicReplies,
        deletedPrivateNotes: notes.deletedPrivateNoteIds.length,
        anonymisedNotifications,
        forgottenInvitations,
        retainedBlocks,
      };
    },
    handle,
  );
}
