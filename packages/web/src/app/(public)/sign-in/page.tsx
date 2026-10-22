import { redirect } from 'next/navigation';
import { currentActor } from '@/server/auth/current-actor';
import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

/**
 * `/sign-in` — the first designed screen in the product, composed from the style guide rather than
 * from a PNG (see sign-in.module.css for the four extrapolations that involved).
 *
 * Someone who already has a session is sent on rather than asked again, which is half of "the
 * session is invisible until it ends".
 *
 * The card only: the centred stage it sits on is the `(public)` layout's, shared with every other
 * page somebody reaches without a session.
 */
export default async function SignInPage() {
  if (await currentActor()) redirect('/');

  return <SignInForm />;
}
