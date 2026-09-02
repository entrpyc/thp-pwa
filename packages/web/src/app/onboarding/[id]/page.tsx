import { notFound, redirect } from 'next/navigation';
import { isOnboardingId } from '@thp/shared';
import { currentActor } from '@/server/auth/current-actor';
import { ONBOARDINGS } from '../onboardings';
import { OnboardingScreen } from './onboarding-screen';

export const dynamic = 'force-dynamic';

/**
 * `/onboarding/{id}` — one onboarding, played full-screen.
 *
 * Deliberately outside the `(member)` chrome: an onboarding is a moment before the product rather
 * than a screen of it, and the top navigation and transport bar would be exits from a tour that
 * has one exit of its own (Skip).
 *
 * No session means sign-in, on the server, before anything renders — a rendering decision, as
 * everywhere: the completion write this screen ends with goes to an API route that refuses
 * independently. An unknown id is a 404 rather than a blank tour, and the same unknown id is
 * refused again by the completion route, so a typo cannot be recorded as a fact.
 */
export default async function OnboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isOnboardingId(id)) notFound();

  const actor = await currentActor();
  if (!actor) redirect('/sign-in');

  return <OnboardingScreen onboardingId={id} slides={ONBOARDINGS[id].slides} />;
}
