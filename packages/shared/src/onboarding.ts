/**
 * The onboarding wire contract.
 *
 * An onboarding is a named, finite sequence of slides the client plays at
 * `/onboarding/{id}`. The *content* of each onboarding (its slides, copy and media) is
 * presentation and lives with the screen in `packages/web`; what lives here is the set of ids the
 * product recognises, because three parties have to agree on it — the page that refuses an unknown
 * id, the API that records a completion, and the sign-in response that routes a fresh session into
 * one.
 */

/** Every onboarding the product has. A new onboarding is one entry here plus its slides in web. */
export const ONBOARDING_IDS = ['new-user'] as const;

export type OnboardingId = (typeof ONBOARDING_IDS)[number];

/**
 * The onboarding every account sees once, at its first sign-in. Named rather than indexed —
 * `ONBOARDING_IDS[0]` would quietly change meaning the day the list is reordered.
 */
export const NEW_USER_ONBOARDING_ID: OnboardingId = 'new-user';

export function isOnboardingId(value: string): value is OnboardingId {
  return (ONBOARDING_IDS as readonly string[]).includes(value);
}

/** The screen an onboarding plays on, on the web origin rather than under the API prefix. */
export function onboardingPagePath(id: OnboardingId): string {
  return `/onboarding/${id}`;
}

/**
 * Path of `PUT /api/v1/onboarding/{id}/completion` — recording that this account has finished (or
 * dismissed) an onboarding. `PUT`, because a completion is a fact that is either recorded or not:
 * marking it twice is the same fact, not a second one.
 */
export function onboardingCompletionPath(id: OnboardingId): string {
  return `/onboarding/${id}/completion`;
}

/** Payload of `PUT /api/v1/onboarding/{id}/completion`. */
export interface OnboardingCompletionPayload {
  readonly onboardingId: OnboardingId;
  /** When the completion was first recorded — a replay reports the original moment, ISO-8601. */
  readonly completedAt: string;
}
