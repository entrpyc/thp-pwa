import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  DELETE_ACCOUNT_PAGE_PATH,
  DELETION_TOKEN_PARAM,
  PROFILE_PAGE_PATH,
  type ApiErrorCode,
} from '@thp/shared';
import { previewAccountDeletion } from '@/server/account-deletion/service';
import { ApiError } from '@/server/api/errors';
import { currentActor } from '@/server/auth/current-actor';
import { CompleteDeletionForm } from './complete-form';
import styles from './delete-account.module.css';
import { RequestDeletionForm } from './request-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Delete account' };

/**
 * `/delete-account` — the public page Google Play shows on the store listing, where somebody
 * without the app asks for a deletion link, and `/delete-account?token=…`, where that link lands
 * ([3.1.8](docs/project/prd.md); Apple 5.1.1(v), Google Play's account-deletion policy).
 *
 * One route for both halves because the mailed link's path was fixed before this page existed
 * (`DELETE_ACCOUNT_PAGE_PATH` in `@thp/shared`), and because a store listing carries one URL. The
 * query parameter decides which half renders:
 *
 * - **No token, and a session: redirected to Profile → Settings** (operator decision). The public
 *   page exists for the person who *cannot* sign in; a member who can is one tap from the in-app
 *   door, which needs no email and no hour-long link. Sending them there rather than offering both
 *   keeps one door per situation.
 * - **No token, no session: the request form.** Reachable by a reviewer with no account, which is
 *   who the listing's URL is for.
 * - **A token: resolved on the server before anything renders**, exactly as `/reset-password` does.
 *   A dead link arrives as prose with no password field under it, and the page calls the service
 *   directly rather than its own API over HTTP, for the reason that page gives. A session makes no
 *   difference here: the link names the account and the password proves the person, whoever is
 *   signed in on this browser.
 */
export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)[DELETION_TOKEN_PARAM];
  const token = typeof raw === 'string' ? raw : null;

  if (token === null) {
    if (await currentActor()) redirect(`${PROFILE_PAGE_PATH}/settings`);
    return <RequestDeletionForm />;
  }

  let email: string;
  try {
    ({ email } = await previewAccountDeletion(token));
  } catch (caught) {
    return <DeadEnd code={caught instanceof ApiError ? caught.code : null} />;
  }

  // The card only; the centred stage is the `(public)` layout's.
  return <CompleteDeletionForm email={email} token={token} />;
}

/**
 * The dead end. **No password field**, deliberately — this screen's job at that point is to say
 * what to do next, and the way to ask again has to be *here*, not described.
 *
 * Expired reads differently from invalid because the API answers two codes: an expired link was
 * real, and its holder is owed another. "Not valid" covers used, replaced and mistyped in one
 * sentence, and names the case the reader most likely is: they already finished, and the account
 * is gone — which is the one outcome where asking again would be the wrong advice.
 */
function DeadEnd({ code }: { code: ApiErrorCode | null }) {
  const expired = code === 'deletion_expired';

  return (
    <div className={styles.card}>
      <div>
        <h1 className={styles.title}>
          {expired ? 'This deletion link expired' : 'This link is not valid'}
        </h1>
        <p className={styles.subtitle}>Vinegard — the private teaching library.</p>
      </div>
      <p className={styles.prose}>
        {expired
          ? 'Deletion links last one hour, which is short on purpose. Ask for another and the new one will work straight away. Nothing has been deleted.'
          : 'This link has already been used, was replaced by a newer one, or was copied incompletely. If you already confirmed with your password, the account is gone and there is nothing more to do. Otherwise, ask for a fresh link.'}
      </p>
      <Link className={styles.link} href={DELETE_ACCOUNT_PAGE_PATH}>
        Send me another link
      </Link>
    </div>
  );
}
