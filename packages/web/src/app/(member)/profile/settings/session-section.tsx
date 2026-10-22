'use client';

import { SignOutButton } from '../../../sign-out-button';
import styles from '../profile.module.css';
import { SettingsSection } from './settings-section';

/**
 * **Session** — the settings page's first section: the way out.
 *
 * Sign-out is what settings opens with, and the display name stayed on the identity page. The
 * choice: [3.1.12](docs/project/prd.md) describes the profile as a display name and an avatar, the
 * two things another member sees on a note's author line, so the name belongs beside the picture.
 * Settings is for what concerns only the account's owner — the session, and later the account's
 * end and the analytics opt-out — and the session is the one such thing the product already has.
 *
 * The button is the one the console header and the menu already use; this is its third home and,
 * as there, it has no opinion about how it looks beyond the class it is handed. Pressing it ends
 * the session server-side and lands on sign-in; there is no confirm step, because a press on a
 * button that says *Sign out* on a page the member navigated to is already the decision.
 */
export function SessionSection() {
  return (
    <SettingsSection
      title="Session"
      lead="You are signed in on this device. Signing out ends the session here and nowhere else."
    >
      <div className={styles.actions}>
        <SignOutButton className={styles.secondary} />
      </div>
    </SettingsSection>
  );
}
