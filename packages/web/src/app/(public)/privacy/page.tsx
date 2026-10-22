import type { Metadata } from 'next';
import Link from 'next/link';
import { OPERATOR_NAME, SUPPORT_EMAIL, SUPPORT_PAGE_PATH, TERMS_PAGE_PATH } from '@thp/shared';
import { PublicDocument, type PublicDocumentSection } from '../public-document';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Privacy policy' };

/**
 * `/privacy` — what the product collects, why, who else sees it, how long it is kept, and how to
 * be rid of it. Apple guideline 5.1.1(i) and Google's listing rules each require a policy a
 * reviewer can open from the store page and a member can open from inside the app; this is the one
 * page both link to.
 *
 * **Every claim here is read off the code, not off a template.** The data section follows the
 * schema (`packages/db/src/schema.ts`); the analytics section follows the adapter
 * (`client/observability/analytics.ts`) and the vocabulary it is typed by; the third parties are
 * the providers `.env.example` names and nothing more. When one of those changes, this page is
 * wrong until it changes too — which is why `updatedOn` is beside the text and not in a footer.
 *
 * **Decisions recorded here**, because the ticket left them to this page:
 *
 * - *The convention for what account deletion erases* was to be read from `packages/db/src` on
 *   main and was not there when this was written. The retention section states the operator's
 *   chosen convention: the account row and everything only it points at are erased; a note with
 *   replies under it leaves the placeholder 3.12.18 already describes, so another member's reply
 *   is not deleted by its parent's author leaving. If the convention that lands differs, this is
 *   the section to edit.
 * - *The opt-out and the deletion control are described as living in Profile → Settings*, where
 *   their sibling branches put them. The operator chose to ship those branches with this page; if
 *   this page ships first, the two sentences that name the settings page are the ones to hold back.
 * - *Backups* keep two nightly full copies (`deploy/pgbackrest/pgbackrest.conf`), so erased data
 *   is gone from them within about three days. Said as "a few days" rather than a number a config
 *   change would falsify.
 * - *The media bucket has no delete operation* (README, "Media store"), so a removed profile
 *   picture's file is unlinked and unreachable rather than destroyed. Said plainly rather than
 *   hidden, because a policy that promises what the system cannot do is worse than one that admits
 *   the limit — and the lawyer's list in the ticket summary carries it.
 * - *Where servers physically are* is stated only where the code or the configuration states it:
 *   PostHog's EU host is asserted by `verify:production`; the rest is named by provider, with the
 *   jurisdiction the operator's own notes give.
 */

const contact = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

const SECTIONS: readonly PublicDocumentSection[] = [
  {
    heading: 'Who we are',
    body: (
      <>
        <p>
          Teaching Hub is run by {OPERATOR_NAME}, a company registered in Bulgaria. We are the data
          controller for the personal data described on this page. You can reach us at {contact},
          or through the <Link href={SUPPORT_PAGE_PATH}>support page</Link>.
        </p>
        <p>
          Teaching Hub is a private app for the members of one teaching group. Nothing in it is
          visible to the public: every page but this one, the terms, the support page and the
          sign-in screens needs an account, and accounts exist by invitation or by registering with
          the group.
        </p>
      </>
    ),
  },
  {
    heading: 'What we collect, and why',
    body: (
      <>
        <p>
          <strong>Your account.</strong> Your email address, a display name of your choosing, an
          optional profile picture, and your password, which we hold only as a hash that cannot be
          turned back into the password. We use these to sign you in, to show who wrote a public
          note, and to send you the emails described below. Your role (member, contributor or
          admin), the date you joined, and whether an admin has deactivated your account are kept
          with them.
        </p>
        <p>
          <strong>Your notes.</strong> A note you write on a recording, the moment in the recording
          it is anchored to, whether you marked it public or private, your replies to other
          members&rsquo; public notes, and the reaction you leave on a public note. Public notes are
          shown to every member under the recording with your display name. Private notes are
          shown to you alone: no admin screen shows them, and no other member can see them.
        </p>
        <p>
          <strong>Your listening.</strong> Where you are in each recording, so playback resumes
          there on any device; your preferred playback speed; how much of each recording you have
          actually listened to, so a teaching you have heard most of is marked as completed; and
          whether you have been through the new-member tour.
        </p>
        <p>
          <strong>Notifications.</strong> The in-app notifications addressed to you (a new
          recording, a reply or reaction to your note, an announcement from an admin) and whether
          you have read each one.
        </p>
        <p>
          <strong>Messages you send us.</strong> When you report a bug or send feedback from the
          app, the title and description you wrote, your display name and your email address are
          sent to us by email so we can reply. Nothing is stored in the app itself: the message is
          the record.
        </p>
        <p>
          <strong>Technical records.</strong> Our server keeps logs of requests, each stamped with a
          correlation id, and a refused request is logged with the account that made it and what
          it asked for. We count sign-in, sign-up and password-reset attempts per network address
          to slow down guessing; those counts live in memory and are not written anywhere.
        </p>
        <p>
          We collect nothing else. There is no location, no contacts, no microphone or camera
          access, no advertising identifier, and no tracking across other apps or sites.
        </p>
      </>
    ),
  },
  {
    heading: 'Product analytics',
    body: (
      <>
        <p>
          We use PostHog, hosted in the European Union, to understand how the app is used: whether
          a teaching is listened to and finished, which tabs are opened, how often notes are
          written, when playback speed is changed, and which pages are visited. Each event names you
          only by the opaque id of your account, with your role as the one property about you. Your
          email address, your display name, the text of your notes and your network address are
          never sent. The app version and whether you use it in a browser, as an installed web app
          or from an app store are sent with every event.
        </p>
        <p>
          Autocapture and session recording are switched off in the code and in the project
          settings, so PostHog never sees what you click or type, and nothing is loaded from
          PostHog at runtime. PostHog keeps events for one year.
        </p>
        <p>
          You can turn analytics off for your account under <strong>Profile &rarr; Settings</strong>.
          Nothing in the app depends on it being on.
        </p>
      </>
    ),
  },
  {
    heading: 'Who else receives your data',
    body: (
      <>
        <p>
          We do not sell your data, and we do not share it with anyone for their own purposes. The
          services below process data on our behalf, under our instructions, to make the product
          work:
        </p>
        <ul>
          <li>
            <strong>Cloudflare</strong> (R2 object storage) holds the audio recordings the group
            uploads, the playback version made from each, series artwork, and profile pictures.
          </li>
          <li>
            <strong>Deepgram</strong> transcribes the recordings. It receives the audio of each
            teaching. It does not receive anything about you.
          </li>
          <li>
            <strong>MiniMax</strong> drafts the summary and description of each teaching from its
            transcript, which is sent to it in full. MiniMax is outside the European Union. It does
            not receive anything about you.
          </li>
          <li>
            <strong>OpenAI</strong> turns text into search vectors: transcript passages, chapter
            text, published summaries, and <em>the text of notes, private notes included</em>. The
            words alone are sent: no name, no account id, no recording title. The vectors are stored
            with us and are what future search and cross-referencing will read.
          </li>
          <li>
            <strong>Resend</strong> delivers our email: invitations, password-reset links, and your
            bug reports and feedback to us. It receives the addresses and the message contents.
          </li>
          <li>
            <strong>PostHog</strong> (EU) receives the analytics events described above.
          </li>
          <li>
            <strong>Contabo</strong> provides the server the app, its worker and its database run
            on. <strong>Grafana Labs</strong>, <strong>UptimeRobot</strong> and{' '}
            <strong>Healthchecks.io</strong> monitor that server; they see whether it is up and how
            hard it is working, never anything about a member.
          </li>
        </ul>
        <p>
          The Bible text quoted beside a teaching comes from the Free Use Bible API. A verse is
          fetched by reference and kept with us; nothing about you is sent.
        </p>
      </>
    ),
  },
  {
    heading: 'How long we keep it',
    body: (
      <>
        <ul>
          <li>
            Your account, notes, listening records and notifications are kept for as long as your
            account exists.
          </li>
          <li>
            A sign-in session lasts 30 days from its last use, and ends at once when you sign out or
            an admin deactivates your account.
          </li>
          <li>
            An invitation or password-reset link expires after seven days, or when it is used or
            replaced.
          </li>
          <li>
            Server logs are rotated and kept for a short time on the server. Database backups are
            taken nightly, and an erased record is gone from them within a few days.
          </li>
          <li>Analytics events are kept by PostHog for one year.</li>
          <li>
            The group&rsquo;s recordings and their transcripts are the group&rsquo;s library and are
            kept indefinitely. They are not your personal data unless you are the speaker.
          </li>
        </ul>
      </>
    ),
  },
  {
    heading: 'Deleting your account',
    body: (
      <>
        <p>
          You can delete your account yourself under <strong>Profile &rarr; Settings</strong>, or
          ask us to by writing to {contact} from the address on the account. Deletion is permanent.
        </p>
        <p>When an account is deleted:</p>
        <ul>
          <li>
            Your email address, display name, password hash, profile picture, role, playback
            positions, listening records, reactions, notifications, sessions and settings are
            erased.
          </li>
          <li>
            Your private notes are erased. Your public notes and replies are erased too; where
            another member replied to one of your notes, a placeholder stays in its place so their
            reply keeps its context, and the placeholder names nobody.
          </li>
          <li>
            Search vectors made from your notes are erased with the notes. OpenAI, which produced
            them, may hold the text it was sent for up to 30 days to check for abuse and does not
            use it to train its models.
          </li>
          <li>
            A removed profile picture&rsquo;s file is unlinked from every account and can no longer
            be reached, but the storage bucket keeps the file itself: the store is built never to
            delete, because the recordings in it must survive every re-processing.
          </li>
          <li>Emails you sent us stay in our mailbox unless you ask us to remove them.</li>
        </ul>
        <p>
          An admin can also deactivate an account without deleting it. A deactivated account cannot
          sign in, and what it wrote stays until the account is deleted.
        </p>
      </>
    ),
  },
  {
    heading: 'Your rights',
    body: (
      <>
        <p>
          Under the General Data Protection Regulation you may ask us for a copy of your personal
          data, to correct it, to erase it, to restrict or object to how we use it, and to receive it
          in a portable form. Your name and picture you can change yourself in your profile;
          everything else, write to {contact} and we will answer within a month.
        </p>
        <p>
          If you believe we have handled your data wrongly, you can complain to the Bulgarian
          Commission for Personal Data Protection, or to the supervisory authority where you live.
        </p>
      </>
    ),
  },
  {
    heading: 'Children',
    body: (
      <p>
        Teaching Hub is for members aged 16 and over. We do not knowingly hold an account for anyone
        younger; if you believe we do, write to {contact} and we will delete it.
      </p>
    ),
  },
  {
    heading: 'Changes to this policy',
    body: (
      <p>
        When this page changes, the date at the top changes with it. A change that affects what we
        collect or who receives it is announced in the app before it takes effect. The{' '}
        <Link href={TERMS_PAGE_PATH}>terms of use</Link> describe the rules for using the product.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return <PublicDocument title="Privacy policy" updatedOn="2026-10-22" sections={SECTIONS} />;
}
