# Store declarations — Apple privacy labels and Google Data safety

**Draft for the operator to copy into App Store Connect and the Google Play Console.** Every answer
below is derived from the privacy policy at `/privacy`
([packages/web/src/app/(public)/privacy/page.tsx](../../packages/web/src/app/(public)/privacy/page.tsx)),
which is itself read off the code. When the policy changes, re-derive this file; when the consoles
ask something this file does not answer, the policy is the source and this file gets the line.

Dated **22 October 2026**, the policy's own date.

Four URLs the consoles ask for, on the production origin:

| Console field | URL |
| :--- | :--- |
| Privacy policy | `https://thp.indepthwebsolutions.com/privacy` |
| Support / contact | `https://thp.indepthwebsolutions.com/support` |
| Terms (EULA, optional on Apple; linked under *user-generated content* on Google) | `https://thp.indepthwebsolutions.com/terms` |
| Account deletion request (Google Play → *Data safety* → *Data deletion*; shown on the store listing) | `https://thp.indepthwebsolutions.com/delete-account` |

The deletion-request page ([packages/web/src/app/(public)/delete-account/page.tsx](../../packages/web/src/app/(public)/delete-account/page.tsx))
works without the app and without a session: it takes an email address, mails a one-hour link,
and the link's page asks for the account's current password before anything is erased. It is
linked from the sign-in screen's legal row beside the three above.

Contact email for both consoles: `asen.angelov@indepthwebsolutions.com`.

## How the answers were reached

Both consoles distinguish three things, and the product's answers follow from how it is built:

- **Collected** means the app sends it off the device to us or to a processor. Everything the
  schema holds about a member is collected; a note draft held in the browser's local storage until
  it is submitted is not.
- **Linked to the user** means it can be tied to the person. Everything here is, because every
  record hangs off the account id and analytics identifies by the same id. Nothing is anonymous.
- **Tracking** (Apple) and **sharing** (Google) mean handing data to a third party for *their*
  purposes — advertising, data brokerage, cross-app profiles. The product does none. Processors
  acting under our instructions (Cloudflare, Deepgram, MiniMax, OpenAI, Resend, PostHog) are
  service providers in both consoles' definitions and are **not** declared as tracking or sharing.

No third-party SDK in the client collects on its own behalf: `posthog-js` is the only analytics
import, and it runs with autocapture, session replay, heatmaps and surveys off. There is no
advertising, crash-reporting or attribution SDK.

## Apple — App Privacy (App Store Connect → App Privacy)

**Does this app collect data?** Yes.

**Do you or your third-party partners use data for tracking?** No.

For every type below: *Linked to the user* = **Yes**; *Used for tracking* = **No**.

| Apple category | Data type | Collected? | Purposes to tick | What it is in the product |
| :--- | :--- | :--- | :--- | :--- |
| Contact Info | Email Address | Yes | App Functionality | Sign-in identity; invitation, reset and feedback mail |
| Contact Info | Name | Yes | App Functionality | The display name shown on public notes |
| Contact Info | Phone Number, Physical Address, Other | No | — | Never asked for |
| User Content | Photos or Videos | Yes | App Functionality | The optional profile picture (member-chosen, square-cropped in the browser) |
| User Content | Other User Content | Yes | App Functionality | Notes (public and private), replies, reactions, bug reports and feedback |
| User Content | Audio Data | No | — | Members do not record or upload audio; the library is uploaded by admins and contributors as the group's content, not as personal data |
| User Content | Emails or Text Messages, Gameplay Content, Customer Support | No | — | Bug reports are sent *to* us as email and not stored in the app; declared under Other User Content above |
| Identifiers | User ID | Yes | App Functionality, Analytics | The account's opaque UUID, which is also the analytics `distinct_id` |
| Identifiers | Device ID | No | — | No device identifier is read; `install_source` is an enum, not an id |
| Usage Data | Product Interaction | Yes | App Functionality, Analytics | Playback position, speed, listening completion, notification read state, onboarding completion; the PostHog events (plays, completions, tabs, notes, chapter jumps, speed changes, notification opens, page views by route pattern) |
| Usage Data | Advertising Data, Other Usage Data | No | — | |
| Diagnostics | Crash Data, Performance Data, Other Diagnostic Data | No | — | No crash or performance reporting from the client; server logs are not sent from the device |
| Location, Health & Fitness, Financial Info, Sensitive Info, Contacts, Browsing History, Search History, Purchases | — | No | — | Not collected. Search is not built; when it is, query text is a privacy-rules exclusion in `docs/project/observability.md` § 5.5 |

**Privacy choices** the review may ask about: a member can delete their own account from the app
(Profile → Settings, project prd 3.1.8 / 5.2.6), and can turn analytics off for their account there
too. Both are stated on `/privacy`.

**Account deletion (guideline 5.1.1(v))**: in-app, under Profile → Settings → *Delete account*
(current password plus a typed confirmation; immediate, no undo), and from outside the app at
`/delete-account` by emailed link plus the current password. Review notes: "Delete the account under
Profile → Settings → Delete account. Members without the app use
https://thp.indepthwebsolutions.com/delete-account." A written request to the support address
remains a third route.

## Google Play — Data safety (Play Console → App content → Data safety)

**Does your app collect or share any of the required user data types?** Yes.

**Is all of the user data collected by your app encrypted in transit?** Yes — the origin is HTTPS
only (nginx returns a 301 to `https://` for every plain request, `deploy/nginx/thp.conf`), and
every processor is reached over TLS.

**Do you provide a way for users to request that their data is deleted?** Yes — in-app account
deletion under Profile → Settings → *Delete account*, the public request page, and by email to the
support address. URL to give (Play shows it on the store listing):
`https://thp.indepthwebsolutions.com/delete-account`.

**Does your app follow the Families policy?** No (the app is 16+, not designed for children).

**Independent security review?** No.

For every row below: *Collected* = **Yes**; *Shared* = **No** (processors are service providers);
*Processed ephemerally* = **No**; *Required or optional* as stated.

| Google category | Data type | Required / optional | Purposes to tick | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Personal info | Name | Required | App functionality, Account management | Display name |
| Personal info | Email address | Required | App functionality, Account management | Sign-in identity and mail |
| Personal info | User IDs | Required | App functionality, Analytics, Account management | Account UUID; analytics `distinct_id` |
| Personal info | Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation, Other info | Not collected | — | **Religious beliefs**: the product is for a religious group, but it asks nothing about a member's beliefs and stores no field about them; membership of the group is not a collected data type. Flagged for the lawyer below. |
| Photos and videos | Photos | Optional | App functionality | Profile picture |
| Photos and videos | Videos | Not collected | — | |
| Audio files | Voice or sound recordings, Music files, Other audio files | Not collected | — | Members neither record nor upload; see the Apple note on Audio Data |
| Messages | Emails, SMS or MMS, Other in-app messages | Not collected | — | Bug reports are mail sent *to* the operator and not held in the app; notes are declared as user-generated content, not messages |
| App activity | App interactions | Required | App functionality, Analytics | Playback position, speed, completion, notification read state; the PostHog event set |
| App activity | In-app search history | Not collected | — | Search is not built |
| App activity | Installed apps | Not collected | — | |
| App activity | Other user-generated content | Required | App functionality | Notes, replies, reactions |
| App activity | Other actions | Not collected | — | |
| Web browsing | Web browsing history | Not collected | — | Page views are sent as route patterns within the app, declared under App interactions |
| App info and performance | Crash logs, Diagnostics, Other app performance data | Not collected | — | Nothing is sent from the device; server logs are the server's |
| Device or other IDs | Device or other IDs | Not collected | — | |
| Location, Financial info, Health and fitness, Contacts, Calendar, Files and docs | — | Not collected | — | |

**Data retention and deletion** (free text, if asked): "Account data is kept while the account
exists and erased on deletion, except that a note another member replied to leaves an anonymous
placeholder. Backups are overwritten within days. Analytics events are kept for one year."

## User-generated content (Google Play UGC policy)

Google requires, for an app with user-generated content: published terms the user accepts, a way
to report content, a way for the operator to remove it, and a way to block or restrict abusive
users. The product's answers:

| Requirement | Where it is |
| :--- | :--- |
| Terms the user accepts before posting | `/terms`, section *Posting rules*, rendered from `POSTING_RULES` in `packages/web/src/app/(public)/terms/posting-rules.ts`. Sign-up requires a ticked consent and records `TERMS_VERSION` (the page's date) on the account; a member whose acceptance is missing or older than the current terms is asked again, with the same rules, before their next note or reply is saved (`PUT /api/v1/users/me/terms`). |
| Removal by the operator | Admins delete any public note or reply (project prd 3.12.10); a placeholder, never the text, remains (3.12.18, 3.12.19). Admins remove any prayer request or any reply on one (3.16.11). The *Reports* console panel removes through the same paths. |
| Restricting abusive users | Admins deactivate an account, ending its sessions at once (3.1.7). A member blocks another from *Block* in the note actions menu, after a confirmation that names the consequence; the blocked list with Unblock is on `/profile/settings`. A block hides each member's notes, replies and reactions from the other and refuses replies and reactions across it. |
| Reporting content | *Report* in the note actions menu on any other member's public note or reply, and *Report* beside any other member's prayer request or reply on one (`/prayer-requests/{id}`): a reason from a fixed list and an optional sentence. Admins are notified in-app and work one queue on `/admin/reports` (dismiss, or remove the note, reply or request); the reporter is notified of the outcome. *Block* sits beside *Report* on both surfaces. |
| Filtering objectionable material (Apple 1.2) | A server-side whole-word check against a short English list (`packages/web/src/server/notes/blocked-words.ts`) refuses a public note, reply or edit at write time. A floor, not moderation: the report path and the admin's delete are the moderation. |

## Age rating

Both questionnaires: no violence, no sexual content, no profanity by design, no gambling, no
controlled substances, **user-generated content: yes** (notes, moderated by admins), **religious
content: yes** (teachings). Expect IARC *Everyone / PEGI 3* with the UGC flag; Apple *4+* with the
*Unrestricted Web Access* answer **No** (the app loads its own origin only). The terms set the
minimum age at 16 as a contractual matter, which is separate from the content rating.

## Questions for the lawyer, carried from the pages

1. **Legal identity on the pages.** `/privacy` and `/terms` name *Indepth Solutions EOOD, a company
   registered in Bulgaria* and an email address. GDPR Article 13 expects the controller's identity
   and contact details; a registered address (and UIC) on the page is the usual reading.
2. **Religious-affiliation data.** Membership of a teaching ministry's private app can be read as
   revealing religious belief (GDPR Article 9), even though no field records it. If so, the lawful
   basis is explicit consent or Article 9(2)(d) (a not-for-profit body's own members), and the
   Google *Political or religious beliefs* row above may need to become *Collected*.
3. **Minimum age.** The terms say 16, the GDPR default. Bulgaria's own threshold for a child's
   consent is lower; the operator may prefer it, or may prefer 18 for a product with public posting.
4. **Governing law and forum.** Bulgarian law and courts, with the consumer carve-out stated in
   general terms. A member in another EU state may keep their own law regardless (Rome I, Brussels
   I recast).
5. **Processors outside the EU.** MiniMax (transcripts, outside the EU), Deepgram, OpenAI and
   Resend (US) receive personal data or content; the transfer mechanism (standard contractual
   clauses, DPF certification) is the operator's to confirm per provider, and the policy says only
   who receives what.
6. **Private notes leaving to OpenAI** for embeddings, words only. The policy says so plainly. The
   lawyer may want a consent step or an opt-out for private-note embedding specifically.
7. **The media bucket never deletes.** A removed profile picture's object is orphaned rather than
   destroyed. The policy admits this; the lawyer may want a scheduled purge of unreferenced avatar
   objects, which would be a change to the media port's "no delete" rule.
8. **Backup retention and erasure.** "Gone within a few days" rests on two nightly full backups
   (`deploy/pgbackrest/pgbackrest.conf`). If the operator raises retention, the policy's wording
   holds but the fact weakens.
9. **Provider retention claims.** The policy states OpenAI's 30-day abuse-monitoring retention and
   no-training position from OpenAI's API terms; the lawyer should confirm it against the current
   terms and decide whether the equivalent for Deepgram and MiniMax belongs on the page.
10. **Announcing changes.** Both pages promise an in-app announcement before a material change takes
    effect. The admin announcement tool (3.17.15) exists; the promise binds the operator to use it.
