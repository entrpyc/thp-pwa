import type { ComponentType } from 'react';
import { AnalyticsSection } from './analytics-section';
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
 * **Only a section that exists is listed.** Account deletion is coming and has no entry until it
 * does — a card that says "not yet" would be a deferred destination drawn rather than dropped,
 * which the codebase does not do. The analytics opt-out was the first to arrive this way.
 *
 * Analytics sits under the session rather than above it: the way out stays the first thing on
 * the page, and consent is the second thing that concerns only the account's owner.
 */
export const SETTINGS_SECTIONS: readonly { readonly id: string; readonly Section: ComponentType }[] =
  [
    { id: 'session', Section: SessionSection },
    { id: 'analytics', Section: AnalyticsSection },
  ];
