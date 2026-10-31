import type { Metadata } from 'next';
import Link from 'next/link';
import { OPERATOR_NAME, PRIVACY_PAGE_PATH, SUPPORT_EMAIL, SUPPORT_PAGE_PATH } from '@thp/shared';
import { PublicDocument, type PublicDocumentSection } from '../public-document';
import { POSTING_RULES } from './posting-rules';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Terms of use' };

/**
 * `/terms` — the rules for having an account and for what a member posts, what admins may do
 * about either, and how an account ends. Google's user-generated-content policy requires terms a
 * member accepts before they post; the control that asks is a later ticket, and this is the page
 * it will link to and the list (`posting-rules.ts`) it will cite.
 *
 * **Decisions recorded here**, because the ticket left them to this page:
 *
 * - *Bulgarian law*, because the operator is a Bulgarian company and a governing-law clause that
 *   names nowhere is one a court chooses for you. The lawyer's list in the ticket summary carries
 *   the question of whether a consumer in another EU state keeps their own law regardless.
 * - *Sixteen* as the minimum age: the GDPR's own threshold for a child's consent, and above any
 *   member state's lower choice, so one number serves every member wherever they live. Also on the
 *   lawyer's list, because Bulgaria's own threshold is lower and the operator may prefer it.
 * - *What admins may do* is read off the policy module and the PRD rather than written broadly:
 *   remove or pin any public note (3.12.10, 3.12.15), deactivate and reactivate an account (3.1.7),
 *   change a role (3.1.5). What they may not do is stated too — read a private note (6.7), rename
 *   a member (3.1.12) — because a member accepting the terms should know the limits they are
 *   accepting as much as the powers.
 * - *The product carries no payment*, so there is no section on fees, refunds or subscriptions
 *   (5.2.7), and nothing here is a consumer-contract price term.
 * - *AI-drafted text* (summaries, descriptions, transcripts) gets its own caveat, because a member
 *   quoting a summary as the teacher's words would be quoting a draft a person reviewed, and the
 *   terms should say so before a dispute does.
 */

const contact = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

const SECTIONS: readonly PublicDocumentSection[] = [
  {
    heading: 'What these terms cover',
    body: (
      <>
        <p>
          These are the terms between you and {OPERATOR_NAME}, which runs Vinegard for the
          members of one teaching group. By using the app you agree to them. How we handle your
          personal data is in the <Link href={PRIVACY_PAGE_PATH}>privacy policy</Link>, which is
          part of these terms.
        </p>
        <p>
          Vinegard is private. It is not open to the public, and an account is for the one
          person it was issued to.
        </p>
      </>
    ),
  },
  {
    heading: 'Your account',
    body: (
      <>
        <ul>
          <li>You must be 16 or older to hold an account.</li>
          <li>
            Your account is yours alone. Keep your password to yourself, and tell us at once if you
            think someone else has used it.
          </li>
          <li>
            Your display name is how other members see you. Use your own name, or a name the group
            knows you by.
          </li>
          <li>
            You can change your name and picture, reset your password, and delete your account at
            any time from your profile.
          </li>
        </ul>
      </>
    ),
  },
  {
    heading: 'Posting rules',
    body: (
      <>
        <p>
          Notes, replies and reactions are the only things members publish, and every member sees
          public ones under the recording they belong to. When you post, you agree to these rules:
        </p>
        <ol>
          {POSTING_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ol>
        <p>
          A private note is yours alone and is never shown to another member or to an admin, but it
          is still held on our systems and is still subject to the law, so the rules about unlawful
          content apply to it as well.
        </p>
      </>
    ),
  },
  {
    heading: 'What admins may do',
    body: (
      <>
        <p>
          The group&rsquo;s admins look after the library and the community. They may:
        </p>
        <ul>
          <li>
            Remove any public note or reply that breaks the posting rules. If replies hang off a
            removed note, a placeholder stays so the replies keep their place; it says only that the
            note was removed, never by whom.
          </li>
          <li>Pin public notes above the others on a recording.</li>
          <li>
            Deactivate an account that breaks these terms, and reactivate it. A deactivated account
            cannot sign in. What it wrote stays unless and until the account is deleted.
          </li>
          <li>Change an account&rsquo;s role, and send announcements to every member.</li>
        </ul>
        <p>
          Admins cannot read your private notes, and cannot change your display name. The record
          of who removed a note is kept in our logs, not shown in the app.
        </p>
      </>
    ),
  },
  {
    heading: 'Your content and ours',
    body: (
      <>
        <p>
          What you write stays yours. By posting a public note or reply you let us show it to the
          group&rsquo;s members, with your display name, for as long as it stays posted. You are
          responsible for what you post and for having the right to post it.
        </p>
        <p>
          The recordings, transcripts, summaries, chapters and artwork in the library belong to the
          group and the speakers. They are for your own listening and study as a member. Do not copy,
          download, republish or share them outside the group without the group&rsquo;s permission.
        </p>
        <p>
          Transcripts, summaries and descriptions are drafted by automated speech recognition and
          language models and reviewed by the group&rsquo;s admins before they are published. They
          are an aid to listening, not a record of what was said. If you need the speaker&rsquo;s
          exact words, listen to the recording.
        </p>
      </>
    ),
  },
  {
    heading: 'Ending your account',
    body: (
      <>
        <p>
          You can delete your account at any time under <strong>Profile &rarr; Settings</strong>,
          or by writing to {contact}. Deletion is permanent. What happens to your notes and your
          data is set out in the privacy policy.
        </p>
        <p>
          We may deactivate or delete an account that breaks these terms, that someone else is
          using, or that was issued by mistake. Where we can, we will tell you why. We may also end
          the service as a whole; if we do, we will tell members in advance and you can take a copy
          of your notes before it closes.
        </p>
      </>
    ),
  },
  {
    heading: 'The service as it is',
    body: (
      <>
        <p>
          Vinegard is provided free of charge to the group&rsquo;s members, as it is and as it is
          available. We work to keep it running and to keep your data safe, but we cannot promise it
          will always be available or free of mistakes, and we are not liable for loss that comes
          from relying on it, except where the law does not let us exclude liability. Nothing in
          these terms limits your rights as a consumer under the law of the country you live in.
        </p>
      </>
    ),
  },
  {
    heading: 'Changes to these terms',
    body: (
      <p>
        When these terms change, the date at the top changes with them, and a change that affects
        what you may post or what we may do is announced in the app before it takes effect. Using
        the app after that is agreeing to the new terms.
      </p>
    ),
  },
  {
    heading: 'Law and contact',
    body: (
      <>
        <p>
          These terms are governed by the law of Bulgaria, and disputes under them are for the
          Bulgarian courts, without taking away any protection the law of your own country gives
          you.
        </p>
        <p>
          Questions about these terms go to {contact}, or through the{' '}
          <Link href={SUPPORT_PAGE_PATH}>support page</Link>.
        </p>
      </>
    ),
  },
];

export default function TermsPage() {
  return <PublicDocument title="Terms of use" updatedOn="2026-10-22" sections={SECTIONS} />;
}
