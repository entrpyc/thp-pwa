import type { ComponentType } from 'react';
import { AnalyticsSection } from './analytics-section';
import { BlockedMembersSection } from './blocked-members-section';
import { DeleteAccountSection } from './delete-account-section';
import { SessionSection } from './session-section';

/**
 * **The settings page's sections** — the one list `/profile/settings` renders, top to bottom.
 *
 * Each section is a component in its own file, built on `SettingsSection` so the page reads as one
 * column of like cards. The page maps over this list and knows nothing else, so a ticket adding a
 * setting touches its own file and one line here, and two such tickets never edit the same file.
 *
 * **To add a setting:**
 *
 * 1. Make `settings/<name>-section.tsx` exporting a component that renders a `SettingsSection`
 *    with its title, its lead and its controls — `session-section.tsx` is the model.
 * 2. Add one entry below, in the order the page should show it.
 *
 * **Only a section that exists is listed.** A card that says "not yet" would be a deferred
 * destination drawn rather than dropped, which the codebase does not do. The analytics opt-out was
 * the first to arrive this way; account deletion the second.
 *
 * The order is the order of consequence. The way out stays the first thing on the page; the blocked
 * list is next, because it is the one setting a member comes here *looking for* after pressing
 * Block on a note; consent follows; and deleting the account is last, so the one button on the
 * page nobody can undo is never the first one under a thumb.
 */
export const SETTINGS_SECTIONS: readonly { readonly id: string; readonly Section: ComponentType }[] =
  [
    { id: 'session', Section: SessionSection },
    { id: 'blocked-members', Section: BlockedMembersSection },
    { id: 'analytics', Section: AnalyticsSection },
    { id: 'delete-account', Section: DeleteAccountSection },
  ];
