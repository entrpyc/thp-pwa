'use client';

import { createContext, useContext } from 'react';

/**
 * **The member's analytics preference, as the running page holds it.**
 *
 * Published by `AnalyticsProvider` and read by the settings card, so that a press on the card
 * reaches the SDK through the one component that owns it rather than through a second import of
 * the adapter. A card that called the adapter itself would apply the preference once and leave
 * the provider believing the old one — and the next mount of the member surface would apply the
 * old one back.
 *
 * `setOptedOut` is the page's half only. The card writes the account first and calls this on
 * success; the context never talks to the API, so what it holds is never ahead of what the
 * account holds.
 *
 * Its own file rather than a second export of the provider's, because the provider is a client
 * component with hooks in it and a context is a value: a page that only needs to read the
 * preference should not have to carry the router hooks the provider imports.
 */
export interface AnalyticsPreference {
  readonly optedOut: boolean;
  readonly setOptedOut: (optedOut: boolean) => void;
}

/**
 * The default is "on, and changing it does nothing" — the state outside the member surface, where
 * no analytics is mounted and there is nothing to change. A card rendered there, which none is,
 * would show the ordinary state and its press would be a no-op rather than a throw.
 */
export const AnalyticsPreferenceContext = createContext<AnalyticsPreference>({
  optedOut: false,
  setOptedOut: () => {},
});

export function useAnalyticsPreference(): AnalyticsPreference {
  return useContext(AnalyticsPreferenceContext);
}
