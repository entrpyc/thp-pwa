import { INVITATION_TOKEN_PARAM, type ApiErrorCode } from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { previewInvitation } from '@/server/invitations/service';
import { AcceptInvitationForm } from './accept-form';
import styles from './accept-invitation.module.css';

export const dynamic = 'force-dynamic';

/**
 * `/accept-invitation?token=…` — where an invitation link lands.
 *
 * The screen resolves the token **on the server, before it renders**, which is the whole reason the
 * preview route exists. A dead invitation therefore arrives as prose with no password field under
 * it, rather than as a form that will refuse whatever is typed into it. There is no flash of a
 * usable form and no wasted keystroke.
 *
 * It calls the invitation service directly rather than fetching its own API over HTTP: this is
 * server code, the service is server code, and a round trip through the network would only add a
 * way for the two to disagree. `GET /api/v1/invitations/accept` answers the same question for
 * anything that is not this page.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)[INVITATION_TOKEN_PARAM];
  const token = typeof raw === 'string' ? raw : null;

  let email: string;
  try {
    ({ email } = await previewInvitation(token));
  } catch (caught) {
    return <DeadEnd code={caught instanceof ApiError ? caught.code : null} />;
  }

  return (
    <main className={styles.screen}>
      <AcceptInvitationForm email={email} token={token ?? ''} />
    </main>
  );
}

/**
 * The dead end. **No password field**, deliberately — a form somebody can fill in and be refused
 * by is worse than no form, and this screen's job at that point is to say what to do next.
 *
 * Expired reads differently from invalid because the API answers with two codes rather than one:
 * an expired invitation was real, and the person holding it is owed "ask for another" rather than
 * "wrong".
 */
function DeadEnd({ code }: { code: ApiErrorCode | null }) {
  const expired = code === 'invitation_expired';

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <div>
          <h1 className={styles.title}>{expired ? 'This invitation expired' : 'This link is not valid'}</h1>
          <p className={styles.subtitle}>Teaching Hub is invitation only.</p>
        </div>
        <p className={styles.deadEnd}>
          {expired
            ? 'Invitations last seven days. Ask an admin to send you a new one — it takes them a moment, and the new link will work straight away.'
            : 'This invitation has already been used, was withdrawn, or the link was copied incompletely. Ask an admin to send you a new one.'}
        </p>
      </div>
    </main>
  );
}
