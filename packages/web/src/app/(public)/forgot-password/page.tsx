import { ForgotPasswordForm } from './forgot-password-form';

export const dynamic = 'force-dynamic';

/**
 * `/forgot-password` — where somebody who cannot get in asks for a way back.
 *
 * Deliberately reachable with a session as well as without one. Somebody signed in on a phone who
 * has forgotten the password on their laptop is exactly the person this screen is for, and
 * redirecting them home would be a puzzle with no answer.
 *
 * The card only; the centred stage is the `(public)` layout's.
 */
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
