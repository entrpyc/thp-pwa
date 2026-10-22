import { REMOVED_MEMBER_DISPLAY_NAME } from '@thp/shared';
import styles from './what-deletion-does.module.css';

/**
 * **What deleting an account does, in plain words** — the one statement both doors show before
 * asking for a password ([3.1.8](docs/project/prd.md)).
 *
 * The text is packages/db/src/README.md's last section ("For the privacy policy") read aloud, item
 * for item, and nothing else: the screen's job is to say what the convention does, not to make a
 * promise of its own. It lives in one component rather than being typed into the settings card and
 * the public page separately because the two are read by the same person a minute apart — once in
 * the app, once from the mailed link — and two wordings would read as two different deletions.
 *
 * The order is the order the reader cares about: what goes, what stays and why, and only then the
 * three things that are kept outside the product and that the policy's author has to be able to
 * point at. "Immediate, no undo" is the last line because it is the one to read right before the
 * password field.
 */
export function WhatDeletionDoes() {
  return (
    <ul className={styles.list}>
      <li>
        <strong>Gone for good:</strong> your account — the email address, display name and
        password — every session on every device, your private notes and their search index, your
        listening positions and history, your reactions, your notifications, your onboarding and
        settings, and your current profile picture. The address is freed for a new account.
      </li>
      <li>
        <strong>Kept:</strong> public notes and replies you wrote stay on their recordings, with
        their text, shown as by &ldquo;{REMOVED_MEMBER_DISPLAY_NAME}&rdquo;, so the threads other
        members are in stay readable. To remove that text, delete those notes one by one from the
        app <em>before</em> deleting the account.
      </li>
      <li>
        <strong>Renamed:</strong> other members&rsquo; notifications about your replies and
        reactions stay, with your name replaced by &ldquo;{REMOVED_MEMBER_DISPLAY_NAME}&rdquo;.
      </li>
      <li>
        <strong>Outside the app:</strong> bug reports you sent went by email and are not stored
        here; the deletion itself is written to the server log with your account id and address,
        kept for the log-retention period; a profile picture you replaced earlier may remain in
        storage as an unreadable file nobody can reach.
      </li>
      <li>
        <strong>Deletion is immediate.</strong> There is no grace period and nothing can be
        restored afterwards, by you or by an admin.
      </li>
    </ul>
  );
}
