'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ANALYTICS_PREFERENCE_PATH,
  PRIVACY_PAGE_PATH,
  type AnalyticsPreferencePayload,
  type AnalyticsPreferenceRequest,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import { useAnalyticsPreference } from '@/client/observability/analytics-preference-context';
import styles from '../profile.module.css';
import { SettingsSection } from './settings-section';

/**
 * **Analytics** — the settings page's second section: consent to product analytics, and the easy
 * way to withdraw it that Apple guideline 5.1.1(ii) asks for.
 *
 * **Off by default means analytics on.** The card names the exception, as the column and the
 * request do: a member who has never been here is collected, and the sentence under the title
 * says exactly what that collection is — the vocabulary in `@thp/shared`, in plain words, with
 * what is never sent said beside what is. The copy is the promise; the sanitiser is what keeps it.
 *
 * **The account is written first, and the page follows.** Pressing the button sends the `PUT`,
 * and only a `200` changes the context the provider re-applies to the SDK. The other order —
 * stop capturing at once, then tell the account — would leave a member whose request failed
 * believing they had withdrawn consent on every device when they had on this one until the next
 * load. One round trip is the price of the card never saying something the account does not hold.
 *
 * **One button that names the action, not a switch.** The codebase has no toggle control and this
 * card does not add one: a button that says *Turn analytics off* is the shape the session card's
 * *Sign out* already has, and a sentence with a `role="status"` beside it says which state the
 * account is in, so a screen reader hears the change without the focus moving.
 *
 * The privacy link points at the policy page `PRIVACY_PAGE_PATH` names (Apple guideline
 * 5.1.1(ii): consent is informed by a policy).
 */

const WRITE_FAILED = 'Could not save that. Nothing has changed — try again in a moment.';

export function AnalyticsSection() {
  const { optedOut, setOptedOut } = useAnalyticsPreference();
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onToggle(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const body: AnalyticsPreferenceRequest = { optedOut: !optedOut };
      const saved = await apiFetch<AnalyticsPreferencePayload>(ANALYTICS_PREFERENCE_PATH, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // What the account now holds, not what was asked for — the two are the same today, and
      // reading the answer is what keeps them the same if the route ever refuses a change.
      setOptedOut(saved.optedOut);
    } catch {
      setFailure(WRITE_FAILED);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      title="Analytics"
      lead="To see which teachings are listened to and which parts of the app are used, we count plays, completions, page views, tab opens, notes created, chapter jumps, speed changes and notifications opened. Each count carries your account's id, your role, the app version and how the app was installed — never your name, your e-mail, what a note says or a web address."
    >
      <p className={styles.quiet}>
        The <Link href={PRIVACY_PAGE_PATH}>privacy policy</Link> says what is kept and for how
        long.
      </p>
      <p className={styles.done} role="status">
        {optedOut
          ? 'Analytics is off for your account, on every device you sign in on.'
          : 'Analytics is on for your account.'}
      </p>
      {failure === null ? null : <p className={styles.failure}>{failure}</p>}
      <div className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={onToggle} disabled={saving}>
          {saving ? 'Saving…' : optedOut ? 'Turn analytics on' : 'Turn analytics off'}
        </button>
      </div>
    </SettingsSection>
  );
}
