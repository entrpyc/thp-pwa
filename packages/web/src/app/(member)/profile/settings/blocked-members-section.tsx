'use client';

import { useEffect, useState } from 'react';
import {
  MEMBER_BLOCKS_PATH,
  memberBlockPath,
  type BlockListPayload,
  type BlockedMemberView,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from '../profile.module.css';
import { SettingsSection } from './settings-section';

/**
 * **Blocked members** — the settings page's list of who this member has chosen not to see, with
 * the way back (Apple guideline 1.2, Google Play's UGC policy: a block the member can find and
 * undo).
 *
 * **It reads what the API answers and decides nothing.** The list is `GET /users/me/blocks`,
 * display names A to Z as the server sorted them, and every Unblock press renders the list the
 * `DELETE` answered rather than removing a row by hand — so a screen that was stale when the
 * button was pressed is right after it. Who has blocked *this* member is listed nowhere, here or
 * anywhere; a block is the blocker's to know.
 *
 * **Unblock takes no confirmation.** It is one press to undo — pressing Block on any of their notes
 * — and nothing is lost in between: the block hid rows, it deleted none, so the notes come back in
 * the next read exactly as they were. The consequence is printed in the lead instead, where a
 * member deciding whether to unblock can read it before the press.
 */

const LOAD_FAILED = 'Could not load your blocked list. Reload the page to try again.';
const WRITE_FAILED = 'Could not unblock that member. Nothing has changed — try again in a moment.';

const SINCE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function since(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : SINCE.format(parsed);
}

export function BlockedMembersSection() {
  const [blocked, setBlocked] = useState<readonly BlockedMemberView[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BlockListPayload>(MEMBER_BLOCKS_PATH, { credentials: 'include' })
      .then((payload) => {
        if (!cancelled) setBlocked(payload.blocked);
      })
      .catch(() => {
        if (!cancelled) setFailure(LOAD_FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function unblock(member: BlockedMemberView): Promise<void> {
    if (busyId !== null) return;
    setBusyId(member.id);
    setFailure(null);
    setDone(null);
    try {
      const payload = await apiFetch<BlockListPayload>(memberBlockPath(member.id), {
        method: 'DELETE',
        credentials: 'include',
      });
      setBlocked(payload.blocked);
      setDone(`${member.displayName} is unblocked. You will see each other's notes again.`);
    } catch (caught) {
      setFailure(caught instanceof ApiClientError ? caught.message : WRITE_FAILED);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SettingsSection
      title="Blocked members"
      lead="Members you have blocked. You do not see each other's notes, replies or reactions, and neither of you can reply or react to the other. Unblocking brings everything back; nothing was deleted."
    >
      {blocked === null && failure === null ? (
        <p className={styles.quiet} role="status">
          Loading…
        </p>
      ) : null}

      {blocked !== null && blocked.length === 0 ? (
        <p className={styles.done} role="status">
          You have not blocked anyone. To block a member, open the menu on one of their notes.
        </p>
      ) : null}

      {blocked !== null && blocked.length > 0 ? (
        <ul className={styles.blockedList} aria-label="Blocked members">
          {blocked.map((member) => (
            <li className={styles.blockedRow} key={member.id}>
              <div className={styles.blockedWho}>
                <p className={styles.blockedName}>{member.displayName}</p>
                <p className={styles.quiet}>Blocked since {since(member.blockedAt)}</p>
              </div>
              <button
                className={styles.secondary}
                type="button"
                aria-label={`Unblock ${member.displayName}`}
                disabled={busyId !== null}
                onClick={() => void unblock(member)}
              >
                {busyId === member.id ? 'Unblocking…' : 'Unblock'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {done === null ? null : (
        <p className={styles.done} role="status">
          {done}
        </p>
      )}
      {failure === null ? null : <p className={styles.failure}>{failure}</p>}
    </SettingsSection>
  );
}
