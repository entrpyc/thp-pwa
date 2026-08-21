import Link from 'next/link';
import {
  FORGOT_PASSWORD_PAGE_PATH,
  RESET_TOKEN_PARAM,
  type ApiErrorCode,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { previewPasswordReset } from '@/server/password-reset/service';
import { ResetPasswordForm } from './reset-form';
import styles from './reset-password.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/reset-password?token=…` — where a reset link lands.
 *
 * The screen resolves the token **on the server, before it renders**, which is the whole reason the
 * preview route exists. A dead link therefore arrives as prose with no password field under it,
 * rather than as a form that will refuse whatever is typed into it. There is no flash of a usable
 * form and no wasted keystroke.
 *
 * It calls the reset service directly rather than fetching its own API over HTTP: this is server
 * code, the service is server code, and a round trip through the network would only add a way for
 * the two to disagree. `GET /api/v1/auth/password-reset` answers the same question for anything
 * that is not this page.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)[RESET_TOKEN_PARAM];
  const token = typeof raw === 'string' ? raw : null;

  let email: string;
  try {
    ({ email } = await previewPasswordReset(token));
  } catch (caught) {
    return <DeadEnd code={caught instanceof ApiError ? caught.code : null} />;
  }

  return (
    <main className={styles.screen}>
      <ResetPasswordForm email={email} token={token ?? ''} />
    </main>
  );
}

/**
 * The dead end. **No password field**, deliberately — a form somebody can fill in and be refused by
 * is worse than no form, and this screen's job at that point is to say what to do next.
 *
 * Expired reads differently from invalid because the API answers with two codes rather than one: an
 * expired link was real, and the person holding it is owed the offer of another one *from this
 * screen* rather than "wrong". A deactivated account is its third case — somebody in that position
 * needs to know their account was ended, not to keep trying links.
 */
function DeadEnd({ code }: { code: ApiErrorCode | null }) {
  const expired = code === 'reset_expired';
  const deactivated = code === 'account_deactivated';

  const heading = deactivated
    ? 'This account is no longer active'
    : expired
      ? 'This reset link expired'
      : 'This link is not valid';

  const explanation = deactivated
    ? 'An admin has deactivated this account, so its password cannot be reset. Ask an admin to restore it — nothing has been deleted.'
    : expired
      ? 'Reset links last one hour, which is short on purpose. Ask for another and the new one will work straight away.'
      : 'This link has already been used, was replaced by a newer one, or was copied incompletely. Ask for another to get a fresh link.';

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div>
          <h1 className={styles.title}>{heading}</h1>
          <p className={styles.subtitle}>Teaching Hub is invitation only.</p>
        </div>
        <p className={styles.prose}>{explanation}</p>
        {deactivated ? (
          <Link className={styles.link} href="/sign-in">
            Back to sign in
          </Link>
        ) : (
          <Link className={styles.link} href={FORGOT_PASSWORD_PAGE_PATH}>
            Send me another link
          </Link>
        )}
      </div>
    </main>
  );
}
