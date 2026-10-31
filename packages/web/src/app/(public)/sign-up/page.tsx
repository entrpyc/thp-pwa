import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SUPPORT_EMAIL } from '@thp/shared';
import { currentActor } from '@/server/auth/current-actor';
import styles from './sign-up.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Get access' };

/**
 * `/sign-up` — registration is closed; this is how to get access instead.
 *
 * The app is published on the stores for the members of one private group, and only people the
 * group already knows should be able to sign in. Self-service registration (docs/project/prd.md,
 * 3.1.15) was therefore withdrawn: the route that created accounts is gone, not merely hidden, so
 * there is no form here and nothing a script could post to. What remains is the one thing a
 * person at this door needs — who to ask. An admin invites them (3.1.3), or they write to the
 * operator's mailbox, the same one `/support` and the privacy policy name.
 *
 * The URL stays, because sign-in and a dead invitation link still point here, and a person who
 * followed an old link should land on an answer rather than a 404.
 *
 * Someone who already has a session is sent on, for the same reason `/sign-in` sends them on: the
 * session is invisible until it ends.
 *
 * The card only; the centred stage is the `(public)` layout's.
 */
export default async function SignUpPage() {
  if (await currentActor()) redirect('/');

  return (
    <div className={styles.card}>
      <div>
        <h1 className={styles.title}>Registration is closed</h1>
        <p className={styles.subtitle}>Vinegard is for the members of the group.</p>
      </div>
      <p className={styles.prose}>
        To get access, ask someone from the group to invite you, or write to{' '}
        <a className={styles.mail} href={`mailto:${SUPPORT_EMAIL}`}>
          {SUPPORT_EMAIL}
        </a>
        . Once your invitation arrives by email, follow its link to set your password.
      </p>
      <Link className={styles.link} href="/sign-in">
        Already have an account? Sign in
      </Link>
    </div>
  );
}
