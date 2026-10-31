import type { Metadata } from 'next';
import Link from 'next/link';
import { REMOVED_MEMBER_DISPLAY_NAME } from '@thp/shared';
import styles from './account-deleted.module.css';

export const metadata: Metadata = { title: 'Account deleted' };

/**
 * `/account-deleted` — where both doors land once the account is gone ([3.1.8](docs/project/prd.md)).
 *
 * A page rather than a state of the screen that did the deleting, because the person has no
 * session by the time there is anything to confirm: the signed-in route cleared the cookie in the
 * response, and a settings page for an account that no longer exists is not a place to stand. The
 * public surface is the only one that can render for them.
 *
 * **Fixed text, nothing in the URL** (operator decision, over carrying the API's retained counts in
 * the query string). The one fact a person is owed here — that their public notes are still on the
 * recordings under a placeholder — is true whatever the number, and a URL that said "3 notes" would
 * be a URL carrying a fact about a deleted account into bookmarks, history and anything the browser
 * syncs. It reads the session not at all: a visitor with one is somebody else on this browser, or a
 * stale tab, and either way the page says what it says.
 */
export default function AccountDeletedPage() {
  return (
    <div className={styles.card}>
      <div>
        <h1 className={styles.title}>Your account has been deleted</h1>
        <p className={styles.subtitle}>Vinegard — the private teaching library.</p>
      </div>
      <p className={styles.prose}>
        The account, every session, your private notes, your listening history and your picture are
        gone, and the address is free to use again. Nothing about it can be restored.
      </p>
      <p className={styles.prose}>
        Public notes and replies you wrote stay on their recordings, shown as by &ldquo;
        {REMOVED_MEMBER_DISPLAY_NAME}&rdquo;, so the conversations other members are in keep their
        shape.
      </p>
      <Link className={styles.link} href="/sign-in">
        Back to sign in
      </Link>
    </div>
  );
}
