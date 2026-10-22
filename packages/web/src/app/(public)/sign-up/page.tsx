import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { SignUpForm } from './sign-up-form';

export const dynamic = 'force-dynamic';

/**
 * `/sign-up` — registering an account (docs/project/prd.md, 3.1.15).
 *
 * Someone who already has a session is sent on rather than offered a second account, for the same
 * reason `/sign-in` sends them on: the session is invisible until it ends.
 *
 * The card only; the centred stage is the `(public)` layout's.
 */
export default async function SignUpPage() {
  if (await currentActor()) redirect('/');

  return <SignUpForm />;
}
