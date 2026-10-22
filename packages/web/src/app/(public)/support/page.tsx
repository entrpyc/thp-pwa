import type { Metadata } from 'next';
import Link from 'next/link';
import {
  FEEDBACK_PAGE_PATH,
  FORGOT_PASSWORD_PAGE_PATH,
  OPERATOR_NAME,
  PRIVACY_PAGE_PATH,
  SUPPORT_EMAIL,
  TERMS_PAGE_PATH,
} from '@thp/shared';
import { PublicDocument, type PublicDocumentSection } from '../public-document';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Support' };

/**
 * `/support` — how to reach the operator, readable without an account. Apple guideline 1.2 wants
 * contact information published, and a store reviewer has no account, so the page cannot be the
 * in-app feedback form; it names the mailbox and points at the form for members who are signed
 * in. Both reach the same inbox (`FEEDBACK_MAIL_TO` defaults to `SUPPORT_EMAIL`), which is the
 * point of naming the address in the vocabulary.
 *
 * **Decisions recorded here:**
 *
 * - *An address rather than a form.* A public form would be a public API route that writes, with
 *   the rate-limit and abuse story sign-up needed, for a page whose whole job is to be reachable.
 *   A `mailto:` is reachable from any device without a session and costs nothing to run.
 * - *The forgot-password route is linked*, because "I cannot sign in" is the one support question
 *   the product already answers by itself, and a reader at the door should be sent there before
 *   they write.
 * - *The feedback form is linked by its path* and described by where a member finds it; the link
 *   is behind the member layout, so a reader without a session who follows it lands on sign-in,
 *   which is the right answer for them.
 */

const contact = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

const SECTIONS: readonly PublicDocumentSection[] = [
  {
    heading: 'Write to us',
    body: (
      <>
        <p>
          Teaching Hub is run by {OPERATOR_NAME}. For anything about the app, your account or your
          data, write to {contact}. We read every message and aim to answer within a few days;
          requests about your personal data are answered within a month at most.
        </p>
        <p>
          Writing from the email address on your account lets us act on a request about that
          account without asking you to prove it is yours.
        </p>
      </>
    ),
  },
  {
    heading: 'Report a bug from inside the app',
    body: (
      <p>
        If you are signed in, <Link href={FEEDBACK_PAGE_PATH}>Report a bug</Link> in the navigation menu
        sends us a report with your name and address already filled in, so we can reply. Use it for
        anything that looks wrong, and for ideas about what the app should do.
      </p>
    ),
  },
  {
    heading: 'Cannot sign in?',
    body: (
      <p>
        If you have forgotten your password,{' '}
        <Link href={FORGOT_PASSWORD_PAGE_PATH}>ask for a reset link</Link>; it arrives by email and
        works for seven days. If you have no account yet, the group&rsquo;s admins can invite you,
        or you can register from the sign-in screen. If an invitation link has expired, ask the
        admin who sent it to resend it.
      </p>
    ),
  },
  {
    heading: 'Your account and your data',
    body: (
      <p>
        You can change your name and picture in your profile, and delete your account under{' '}
        <strong>Profile &rarr; Settings</strong>. To ask for a copy of your data, or to have it
        deleted on your behalf, write to {contact}. What we hold and for how long is set out in the{' '}
        <Link href={PRIVACY_PAGE_PATH}>privacy policy</Link>.
      </p>
    ),
  },
  {
    heading: 'Policies',
    body: (
      <ul>
        <li>
          <Link href={PRIVACY_PAGE_PATH}>Privacy policy</Link>: what we collect, who else receives
          it, and how to be rid of it.
        </li>
        <li>
          <Link href={TERMS_PAGE_PATH}>Terms of use</Link>: the rules for your account and for what
          you post.
        </li>
      </ul>
    ),
  },
];

export default function SupportPage() {
  return <PublicDocument title="Support" updatedOn="2026-10-22" sections={SECTIONS} />;
}
