# What happens to a member's data when their account is deleted

The convention behind `deleteUserAccount` ([account-deletion.ts](./account-deletion.ts)) and
behind every `onDelete` clause that points at `user` in [schema.ts](./schema.ts). It is written
once, here, so a later table can follow it by reading this page and declaring its own clause —
the deletion service never has to learn the table's name. It is also the page the privacy
policy's author reads: the last section is what the product can and cannot promise.

The requirements are docs/project/prd.md 3.1.8 (a member deletes their own account from within
the app), 3.1.9 (private content goes with it), 3.1.10 (public notes are retained under a
removed-member placeholder) and 3.1.11 (the last active admin cannot be removed). Apple guideline
5.1.1(v) and Google Play's account-deletion policy are why it is deletion and not deactivation,
and why it can be started from a public page by somebody who no longer has the app.

## The mechanism, in one paragraph

Deletion writes a **fresh placeholder row** in `user` — display name `Removed member`, a sentinel
address under `removed.invalid`, a password hash nothing verifies against, `deactivated_at` and
`deleted_at` both set — re-points the person's **public** notes and replies at it, deletes their
**private** notes, rewrites the notifications they caused for other members, forgets the
invitations addressed to them, and then **deletes the real row**. Deleting the real row is what
makes the rest happen: every foreign key to `user` fires exactly as the schema declares it. The
placeholder is a new id, not the old row erased in place, so a thread stays coherent (3.1.10)
while nothing about the person — not even their id — remains on any row.

Deletion is immediate. There is no grace period and no undo; the confirmation is the current
password, on both doors.

## The rule for a table, by what the row is

A table joins the convention by asking which of these its `user` column is, and declaring the
matching `onDelete`. Nothing else is needed.

| The row is… | `onDelete` | Why |
| --- | --- | --- |
| **a fact about the person and nothing else** — a session, a reset or deletion token, a playback position, an onboarding completion, a reaction, a notification *for* them, the vector of a private note | `cascade` | Meaningless without the person. Goes with them. |
| **a record of something that happened to somebody else, that this person caused** — `invited_by`, `deleted_by`, `pinned_by`, `reviewed_by`, `corrected_by_user_id`, `sent_by`, `raised_by`, `created_by`, `actor_id` | `set null` | The record survives; who did it becomes "an account since removed", which every reader of these columns already handles. |
| **public content the person authored for the group** — a public note or reply, including a tombstone | `restrict`, and the erasure re-points it at the placeholder first | 3.1.10. The restrict is deliberate and stays: a hand at the database cannot take a group's study notes with one person's row. The erasure satisfies it by moving the rows, never by weakening the key. |
| **private content the person authored** — a private note | `restrict`, and the erasure deletes it first | 3.1.9. Deleted outright rather than tombstoned: a tombstone holds a thread's shape, and a private note has no thread. |
| **a record that holds the person's address with no account behind it** — an invitation *to* them | none (no key) and the erasure deletes it by address | The only fact it holds about anybody is the address. Deleting it is also what frees the address for a new account. |

Three things the schema cannot do and the erasure does explicitly, each in the module that owns
the table: [notes.ts](./notes.ts) `reassignNotesOfDeletedAuthor`,
[notifications.ts](./notifications.ts) `anonymiseNotificationsByActor`,
[invitations.ts](./invitations.ts) `deleteInvitationsAddressedTo`. A later table that needs an
explicit step of its own adds a function beside its other statements and one call in
`account-deletion.ts`; that is the only time the service learns a table's name.

## What each existing table does, today

Every one of these is a declared `onDelete` in `schema.ts`; this list is the convention checked
against the schema, not a second copy of it.

- `session`, `password_reset`, `account_deletion_request` — cascade. Every device is signed out
  by the row going; the cookie the browser still holds resolves to nothing.
- `playback_progress`, `user_onboarding`, `note_reaction` — cascade. Reaction counts other
  members see drop by one.
- `notification.user_id` — cascade: the person's own inbox goes. `notification.actor_id` — set
  null, and the title is rewritten first to name the placeholder ("Removed member replied to
  your note"), because the title is denormalised and the other member's record of having been
  told stays.
- `embedding.owner_user_id` — cascade: the vectors of private notes go. Vectors of public notes
  have no owner and stay with the note.
- `note.author_id` — restrict; see the table above. `note.deleted_by` — set null.
- `note_pin.pinned_by`, `invitation.invited_by`, `review_item.reviewed_by`,
  `segment.corrected_by_user_id`, `announcement.sent_by`, `spend_ceiling_raise.raised_by`,
  `sound_profile.created_by` — set null.
- `note_report.reporter_id`, `note_report.resolved_by` — set null: a report made and a decision
  taken are records of something that happened to somebody else's note. The admins' notice that
  this person reported a note has its title rewritten to the placeholder's name, as a reply's is.
  `note_report.note_id` cascades with the note, which a public note's re-pointing never fires.
- `highlight.user_id` — cascade: a member's Highlights playlist is a fact about the person and
  nothing else, and 3.1.9 names it among what goes with the account. `highlight.note_id` cascades
  with the note — never fired by a public note's re-pointing, and a private note's hard delete
  takes its entry with it.
- `invitation.email` — rows addressed to the person are deleted.
- `user` itself — the placeholder is excluded from the member list (`listUsers`) and from every
  guarded admin write (`withLastAdminGuard`, `reactivateUser`), so nobody can deactivate,
  promote, restore or rename a row no person owns. It can never sign in: its hash is
  unverifiable and it is deactivated, and the check `user_deleted_is_deactivated` holds the
  second half at the database.

## The last admin

`deleteUserAccount` runs inside `withLastAdminGuard`, the same lock deactivation and demotion
use (3.1.11). The only active admin is refused with `last_admin`, and the message says to make
somebody else an admin first. The refusal leaves everything as it was, including a mailed
deletion token, so the same link works once the promotion is done.

## Storage objects

The media store has one delete, `deleteAvatar`, confined by the adapter to the `avatars/`
prefix (packages/media/src/store.ts; tools/media-boundary.ts pins the name). Deletion calls it
**after** the database transaction commits, because the store is not transactional and the
wrong failure is a person with an account and no picture. The right failure — the store down at
that instant — leaves an orphan object under a uuid key that nothing can ever mint a URL for
again, logged at `error` as `account.delete.avatar-orphaned` with the key, for an operator to
remove by hand.

Two things the store keeps that are not deleted, and why:

- **Superseded avatars.** Changing or removing a picture from the profile repoints the account
  and leaves the old object; only deleting the account deletes the current one. An earlier
  picture a person replaced before deleting is therefore still in the bucket, under a uuid,
  unreachable. Deleting those would mean the product keeping a history of every key an account
  ever pointed at, which it deliberately does not.
- **A signed avatar URL already handed out** stays valid until it expires — a day at most, the
  cache window the note list hands out — and only to a client that already held it.

## The audit log

What the Auditability NFR asks for is a structured log line, not a table. Deletion writes one,
`account.delete`, with the four fields every audit line carries — the actor's id and address,
the action, the target — plus which door it came through, the placeholder id and the counts of
what was retained and removed. The actor *is* the person being deleted, so **their address and
id outlive the row in the log**, for as long as the deployment keeps logs; that is the record of
who removed what (3.12.10's rule applied to an account) and it is the operator's retention policy
that bounds it. No other log line written after the deletion can name them.

## For the privacy policy

What the product can promise, and what it cannot:

- Deleting an account removes the account, the password hash, the display name, the address,
  every session, every private note and its search vector, the Highlights playlist, listening
  positions and history,
  onboarding state, reactions, the in-app inbox, and the current profile picture. It frees the
  address for a new account.
- Public notes and replies the person wrote stay on the recordings they were written on, with
  their text, shown as by "Removed member". Deleting them first, one by one from the app, is how
  a person removes that text before deleting the account; a deleted note's text is kept by nobody
  (3.12.19).
- Other members' notifications about the person's replies and reactions stay, with the person's
  name replaced. The excerpt of a public reply inside such a notification stays, as the reply
  does.
- Bug reports and feedback the person sent went by email to a maintainer's inbox at the time
  (3.1.22) and are not stored by the product; the product cannot recall them.
- The deletion itself is logged with the person's id and address, and earlier log lines that
  carry them are kept for the deployment's log-retention period.
- Analytics events were sent under the account's opaque id and role, never the address or name;
  the id names nothing after deletion.
- Profile pictures the person replaced before deleting may remain in storage as unreadable
  orphan objects.
