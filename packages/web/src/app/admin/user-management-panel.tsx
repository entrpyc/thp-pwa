'use client';

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  INVITATIONS_PATH,
  ROLE,
  ROLES,
  ROLE_LABEL,
  USERS_PATH,
  type AccountListPayload,
  type AccountSummary,
  type InvitationListPayload,
  type InvitationStatus,
  type InvitationSummary,
  type Role,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './admin.module.css';

/**
 * The console's first and only panel: who can get in, who is on their way in, and the four writes
 * that change either answer.
 *
 * A client module. It imports no server module, holds no database access and calls the absolute API
 * origin like every other call the client makes — steps 3 and 4 shipped all nine routes below and
 * every one of them is refused server-side by the policy module, so nothing here is a permission.
 * Hiding a control is the most this file is allowed to do, and the suite proves the refusal is the
 * API's by driving `GET /api/v1/users` from a member's session directly.
 *
 * Four decisions worth stating, because each is the difference between a console and a CRUD table:
 *
 * 1. **Every mutation re-fetches the list it affected. No optimistic UI.** Two small lists and a
 *    local API — the refetch is imperceptible, and optimism here means a console that can display a
 *    state the database refused. It refetches after a *refusal* too: `account_state_conflict`
 *    happens precisely when the row on screen is stale, and answering it by correcting the row is
 *    better than answering it with a sentence.
 * 2. **The API's own words are printed where the press happened.** `last_admin` says to promote
 *    somebody first; `email_taken` says invitations are for addresses that do not have an account.
 *    Replacing either with "Something went wrong" throws away the only part an operator can act on.
 * 3. **Deactivation takes a confirming press that names the account**, because ending a person's
 *    access should never be one stray tap on a phone. Reactivation does not — restoring access is
 *    not the dangerous direction.
 * 4. **Your own row is labelled, not disarmed.** The controls stay: the last-admin guard only fires
 *    when the target *is* the only active admin, and only an admin can reach these routes, so
 *    demoting or deactivating the last admin is a thing that can only ever happen on your own row.
 *    Hiding the controls there would hide the one guardrail this console most needs to show. The
 *    API refuses; this screen says who it is about to act on.
 */

/** One fixed rendering of a date, so a console read in two places says the same thing. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/** The machine-readable value stays in the markup, so "which expiry is this" is never a guess. */
function When({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatDay(iso)}</time>;
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: 'Pending',
  expired: 'Expired',
  revoked: 'Revoked',
  accepted: 'Accepted',
};

/** What happened where you pressed. `refused` is announced; `done` is merely reported. */
interface Note {
  readonly tone: 'refused' | 'done';
  readonly text: string;
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

export function UserManagementPanel({
  signedInId,
  signedInName,
}: {
  signedInId: string;
  signedInName: string;
}) {
  const emailId = useId();
  const inviteErrorId = useId();

  const [accounts, setAccounts] = useState<readonly AccountSummary[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<readonly InvitationSummary[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);

  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>(ROLE.member);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const loadAccounts = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<AccountListPayload>(USERS_PATH, { credentials: 'include' });
      // Rendered in the order the API sent, never re-sorted here: `listUsers` orders by creation
      // and a second ordering in the client is a second answer to "who joined when".
      setAccounts(payload.accounts);
      setAccountsError(null);
    } catch (caught) {
      setAccounts(null);
      setAccountsError(describeFailure(caught));
    }
  }, []);

  const loadInvitations = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<InvitationListPayload>(INVITATIONS_PATH, {
        credentials: 'include',
      });
      // Everything except accepted. An accepted invitation is an account now and is already in the
      // list above; showing it twice is noise on the one list that answers "who is still out".
      setInvitations(payload.invitations.filter((entry) => entry.status !== 'accepted'));
      setInvitationsError(null);
    } catch (caught) {
      setInvitations(null);
      setInvitationsError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    void loadInvitations();
  }, [loadAccounts, loadInvitations]);

  const setNote = useCallback((id: string, note: Note | null): void => {
    setNotes((current) => {
      const next = { ...current };
      if (note === null) delete next[id];
      else next[id] = note;
      return next;
    });
  }, []);

  /**
   * One row, one action, one outcome. The reload runs whichever way the API answered, so the row
   * always settles into what the database actually holds rather than into what was pressed.
   */
  async function act(
    id: string,
    request: () => Promise<unknown>,
    reload: () => Promise<void>,
    done: string,
  ): Promise<void> {
    if (busyId !== null) return;
    setBusyId(id);
    setNote(id, null);
    setConfirming(null);

    let note: Note;
    try {
      await request();
      note = { tone: 'done', text: done };
    } catch (caught) {
      note = { tone: 'refused', text: describeFailure(caught) };
    }

    await reload();
    setNote(id, note);
    setBusyId(null);
  }

  function assignRole(account: AccountSummary, next: Role): void {
    const { id, displayName } = account;
    void act(
      id,
      () =>
        apiFetch(`${USERS_PATH}/${id}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: next }),
        }),
      loadAccounts,
      // Re-assigning the role somebody already holds is not an error — the API answers with the
      // current state on purpose — so this sentence is true either way and reads as success.
      `${displayName} is ${ROLE_LABEL[next]}.`,
    );
  }

  function deactivate(account: AccountSummary): void {
    const { id, displayName } = account;
    void act(
      id,
      () => apiFetch(`${USERS_PATH}/${id}/deactivate`, { method: 'POST', credentials: 'include' }),
      loadAccounts,
      `${displayName} can no longer sign in.`,
    );
  }

  function reactivate(account: AccountSummary): void {
    const { id, displayName } = account;
    void act(
      id,
      () => apiFetch(`${USERS_PATH}/${id}/reactivate`, { method: 'POST', credentials: 'include' }),
      loadAccounts,
      `${displayName} can sign in again.`,
    );
  }

  function revoke(invitation: InvitationSummary): void {
    const { id, email } = invitation;
    void act(
      id,
      () => apiFetch(`${INVITATIONS_PATH}/${id}`, { method: 'DELETE', credentials: 'include' }),
      loadInvitations,
      `The invitation to ${email} no longer works.`,
    );
  }

  function resend(invitation: InvitationSummary): void {
    const { id, email } = invitation;
    void act(
      id,
      () =>
        apiFetch(`${INVITATIONS_PATH}/${id}/resend`, { method: 'POST', credentials: 'include' }),
      loadInvitations,
      // The API answers with a **new** invitation on a fresh window; the old row is revoked by that
      // same call, so after the reload exactly one row for this address is still open.
      `A fresh link is on its way to ${email}. The previous one no longer works.`,
    );
  }

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inviting) return;
    setInviting(true);
    setInviteError(null);
    setInviteDone(null);

    try {
      await apiFetch(INVITATIONS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviteDone(`Invitation sent to ${inviteEmail}.`);
      setInviteEmail('');
      await loadInvitations();
    } catch (caught) {
      // What was typed stays exactly where it is. Being refused costs nothing but the press.
      setInviteError(describeFailure(caught));
    }
    setInviting(false);
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="invite-heading">
        <div>
          <h2 className={styles.sectionTitle} id="invite-heading">
            Invite somebody
          </h2>
          <p className={styles.sectionNote}>
            They get a link that lasts seven days and choose their own password.
          </p>
        </div>

        <form className={styles.inviteForm} onSubmit={onInvite} noValidate>
          <div className={styles.inviteRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={emailId}>
                Email
              </label>
              <input
                className={styles.input}
                id={emailId}
                name="email"
                type="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                {...(inviteError === null ? {} : { 'aria-describedby': inviteErrorId })}
              />
            </div>

            <div className={styles.fieldTight}>
              <span className={styles.label}>Role</span>
              <RolePicker
                label="Role for the invitation"
                value={inviteRole}
                disabled={inviting}
                onPick={setInviteRole}
              />
            </div>

            <button className={styles.submit} type="submit" disabled={inviting}>
              {inviting ? 'Sending…' : 'Send invitation'}
            </button>
          </div>

          {inviteError === null ? null : (
            <p className={styles.error} id={inviteErrorId} role="alert">
              {inviteError}
            </p>
          )}
          {inviteDone === null ? null : (
            <p className={styles.done} role="status">
              {inviteDone}
            </p>
          )}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="members-heading">
        <div>
          <h2 className={styles.sectionTitle} id="members-heading">
            Members
          </h2>
          <p className={styles.sectionNote}>Everyone with an account, oldest first.</p>
        </div>

        <ListState
          failure={accountsError}
          loading={accounts === null}
          empty={accounts !== null && accounts.length === 0}
          loadingText="Loading accounts…"
          emptyText="No accounts yet."
        >
          <ul className={styles.list}>
            {(accounts ?? []).map((account) => {
              const { id, email, displayName, role, active, deactivatedAt } = account;
              const note = notes[id];
              const busy = busyId === id;
              const isSelf = id === signedInId;

              return (
                <li
                  key={id}
                  className={active ? styles.row : `${styles.row} ${styles.rowInactive}`}
                >
                  <div className={styles.rowIdentity}>
                    <p className={styles.rowName}>{displayName}</p>
                    <p className={styles.rowMeta}>{email}</p>
                    {isSelf ? <p className={styles.rowSelf}>This is you.</p> : null}
                  </div>

                  <div className={styles.rowControls}>
                    {active ? null : (
                      <span className={`${styles.chip} ${styles.chipInactive}`}>
                        Deactivated
                        {deactivatedAt === null ? null : (
                          <>
                            {' '}
                            <When iso={deactivatedAt} />
                          </>
                        )}
                      </span>
                    )}

                    <RolePicker
                      label={`Role for ${displayName}`}
                      value={role}
                      disabled={busy}
                      onPick={(next) => assignRole(account, next)}
                    />

                    {active ? (
                      <button
                        className={styles.action}
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirming(id)}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        className={styles.action}
                        type="button"
                        disabled={busy}
                        onClick={() => reactivate(account)}
                      >
                        Restore
                      </button>
                    )}
                  </div>

                  {confirming === id ? (
                    <div className={styles.confirm}>
                      <p className={styles.confirmText}>
                        End access for {displayName} ({email})?
                        {isSelf
                          ? ' That is your own account — you would be signed out immediately.'
                          : ' They are signed out immediately and keep everything they have written.'}
                      </p>
                      <div className={styles.confirmActions}>
                        <button
                          className={styles.actionStrong}
                          type="button"
                          disabled={busy}
                          onClick={() => deactivate(account)}
                        >
                          Yes, end access
                        </button>
                        <button
                          className={styles.action}
                          type="button"
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {note === undefined ? null : <RowNote note={note} />}
                </li>
              );
            })}
          </ul>
        </ListState>
      </section>

      <section className={styles.section} aria-labelledby="invitations-heading">
        <div>
          <h2 className={styles.sectionTitle} id="invitations-heading">
            Invitations
          </h2>
          <p className={styles.sectionNote}>
            Everyone on their way in. Accepted invitations are accounts and appear above.
          </p>
        </div>

        <ListState
          failure={invitationsError}
          loading={invitations === null}
          empty={invitations !== null && invitations.length === 0}
          loadingText="Loading invitations…"
          emptyText="No invitations outstanding. Invite somebody above and they will appear here."
        >
          <ul className={styles.list}>
            {(invitations ?? []).map((invitation) => {
              const { id, email, role, status, expiresAt, createdAt } = invitation;
              const note = notes[id];
              const busy = busyId === id;
              // Revoked and accepted are closed; the API refuses both actions on either, so
              // offering them would be offering a refusal.
              const open = status === 'pending' || status === 'expired';

              return (
                <li key={id} className={open ? styles.row : `${styles.row} ${styles.rowInactive}`}>
                  <div className={styles.rowIdentity}>
                    <p className={styles.rowName}>{email}</p>
                    <p className={styles.rowMeta}>
                      {ROLE_LABEL[role]}
                      {' · '}
                      {status === 'pending' ? (
                        <>
                          Expires <When iso={expiresAt} />
                        </>
                      ) : status === 'expired' ? (
                        <>
                          Expired <When iso={expiresAt} />
                        </>
                      ) : (
                        <>
                          Invited <When iso={createdAt} />
                        </>
                      )}
                    </p>
                  </div>

                  <div className={styles.rowControls}>
                    <span
                      className={`${styles.chip} ${
                        status === 'pending' ? styles.chipPending : styles.chipInactive
                      }`}
                    >
                      {STATUS_LABEL[status]}
                    </span>

                    {open ? (
                      <>
                        <button
                          className={styles.action}
                          type="button"
                          disabled={busy}
                          onClick={() => resend(invitation)}
                        >
                          Resend
                        </button>
                        <button
                          className={styles.action}
                          type="button"
                          disabled={busy}
                          onClick={() => revoke(invitation)}
                        >
                          Revoke
                        </button>
                      </>
                    ) : null}
                  </div>

                  {note === undefined ? null : <RowNote note={note} />}
                </li>
              );
            })}
          </ul>
        </ListState>
      </section>

      <p className={styles.footnote}>
        Signed in as {signedInName}. Every action here is authorised by the API, not by this screen.
      </p>
    </div>
  );
}

/**
 * "Nothing to show" and "could not load" are never the same screen. A failure states itself; it
 * does not quietly render an empty list and let an operator conclude the church has no members.
 */
function ListState({
  failure,
  loading,
  empty,
  loadingText,
  emptyText,
  children,
}: {
  failure: string | null;
  loading: boolean;
  empty: boolean;
  loadingText: string;
  emptyText: string;
  children: ReactNode;
}) {
  if (failure !== null) {
    return (
      <p className={styles.failure} role="alert">
        {failure}
      </p>
    );
  }
  if (loading) return <p className={styles.sectionNote}>{loadingText}</p>;
  if (empty) return <p className={styles.empty}>{emptyText}</p>;
  return <>{children}</>;
}

function RowNote({ note }: { note: Note }) {
  return (
    <p
      className={note.tone === 'refused' ? styles.rowRefusal : styles.rowDone}
      role={note.tone === 'refused' ? 'alert' : 'status'}
    >
      {note.text}
    </p>
  );
}

/**
 * The picker, built by iterating {@link ROLES} rather than by listing what this product happens to
 * have today — which is also the only way to build one at all, since tools/role-usage.ts refuses a
 * role literal outside the module that declares them.
 *
 * Pills rather than a `select`: a segmented control is one press on a phone, it shows both options
 * without opening anything, and pressing the role somebody already holds is a legitimate press the
 * API answers with the current state.
 */
function RolePicker({
  label,
  value,
  disabled,
  onPick,
}: {
  label: string;
  value: Role;
  disabled: boolean;
  onPick: (next: Role) => void;
}) {
  return (
    <div className={styles.rolePicker} role="group" aria-label={label}>
      {ROLES.map((option) => (
        <button
          key={option}
          className={styles.roleOption}
          type="button"
          aria-pressed={option === value}
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          {ROLE_LABEL[option]}
        </button>
      ))}
    </div>
  );
}
