# Security audit — Teaching Hub (29 October 2026)

Scope: the whole repository at `main` (`2145165`, after PR #67 merged the fixes for the 28 October
audit): infrastructure (`deploy/`, `docker-compose.yml`, `ecosystem.config.cjs`, `.github/workflows`,
`scripts/`), the web app (`packages/web`, every `route.ts` under `api/v1`), the data layer
(`packages/db`, migrations and snapshots), the worker and integrations (`packages/worker`, `media`,
`push`, `bible`, `embed`, mail), the client, service worker and Capacitor shell, dependencies
(`npm audit`), the git history (secret scan), CI results and the version the live site serves.

Method: fresh manual review by four independent reviewers (auth/routes, data layer, worker/external,
client/CSP) plus an infrastructure pass, with every finding that drives a severity re-read from the
code by the author of this document. Nothing was changed. Nothing was executed against production
except two unauthenticated public `GET`s to read the served build version.

Severity scale as in the 28 October audit: **Critical** remote compromise or broken core function
with no precondition; **High** compromise or large exposure with a realistic precondition; **Medium**
integrity, privacy or cost impact for members; **Low** hardening; **Info** worth knowing.

---

## Summary

| # | Severity | Finding |
|---|----------|---------|
| 1 | Critical | Schema and migrations have drifted: `sos_report`, the `sos_reported` enum value and two unique indexes exist in `schema.ts` only. v1.7.0 is live with this gap: prayer-request reports 500, account deletion 500, and every push delivery fails. CI is red on `main`; the deploy shipped with the CI gate skipped. |
| 2 | High | Anonymous prayer requests are de-anonymised through member blocks (an oracle), through the author's own replies, and in the thread-reply notification title |
| 3 | Medium | Cross-site request forgery and login-CSRF are possible from any sibling host under the shared parent domain: no `__Host-` cookie prefix, no Origin or Content-Type check on the API |
| 4 | Medium | Presigned PUT grants stay valid for an hour after the object was verified and committed: a member can swap a verified avatar or note image for any body of any size |
| 5 | Medium | Members can block admins, hiding their content from moderation and turning admin close/delete into 404 |
| 6 | Medium | Removing a reported prayer request cascades away the report record itself; deleting an account erases the member's whole SOS footprint, including other members' replies, and keeps their name in `sos_raised` titles |
| 7 | Medium | Search result cache serves unpublished, deleted, moderated or blocked content for up to a week |
| 8 | Medium | No per-actor budget on notes, replies, prayer requests, reports or blocks: push storms and spam; `DELETE /users/me` is an unthrottled password oracle for a session holder |
| 9 | Medium | Password-reset and deletion request routes answer uniformly but not in uniform time: an account-existence timing oracle |
| 10 | Medium | Android shell has `allowBackup="true"`: WebView cookie jar, IndexedDB and downloads leave the device through Auto Backup |
| 11 | Medium | Offline page cache serves `/profile` (with the member's email) and `/notifications` to whoever holds the device offline; document and RSC cache keys collide |
| 12 | Medium | One transcription job's spend is unbounded; a Deepgram timeout is billed but never ledgered; in-flight jobs do not count toward the ceiling |
| 13 | Low | Sessions never expire absolutely; no change-password or sign-out-everywhere route |
| 14 | Low | Note-image keys are not bound to the member who was granted them |
| 15 | Low | Deactivated accounts can still complete self-deletion |
| 16 | Low | Flow-session `recordingIds` is parsed unbounded; playback `positionMs`/`durationMs` unbounded (22003 answers 500); `listened_ms` has no total cap |
| 17 | Low | Check-then-act races: duplicate reports, SOS open-limit, outbox sync replay creating a note twice |
| 18 | Low | Flow-session items keep serving chapter text of an unpublished recording |
| 19 | Low | Mailer logs recipient addresses and member-written subjects; provider error bodies reach PostHog |
| 20 | Low | ffmpeg: unbounded stderr buffer, whole rendition read into memory, no `-protocol_whitelist`; renditions and previews never deleted |
| 21 | Low | FCM and Web Push sends have no timeout and are awaited inside request handlers |
| 22 | Low | Push landing path check lets `/\host` leave the origin; previous account's `session:*` meta survives a different sign-in; downloads keep other members' notes after sign-out |
| 23 | Low | Deploy pipeline: `skip_ci_gate` was used for v1.7.0; deploy key is a repository-level secret; the box deploys any already-published tag (rollback to a vulnerable release) |
| 24 | Low | 403 vs 404 discloses existence of another member's private note id; block route discloses whether a uuid is a live user |
| 25 | Info | `next start` binds every interface; only ufw and loopback nginx keep `:3000` private, so a sibling process on the box can spoof `X-Real-IP` |
| 26 | Info | nginx `/relay/` forwards any path to PostHog; CSP has no reporting endpoint; `style-src 'unsafe-inline'` |
| 27 | Info | Private notes and search queries go to OpenAI; APNs/FCM bodies carry note and prayer text in the clear to Apple and Google |
| 28 | Info | `npm audit`: 4 moderate, all development-only (`drizzle-kit` → `esbuild`); local `node_modules` still holds nodemailer 7.0.13 (lockfile says 10.3.1, run `npm ci`) |
| 29 | Info | Still open from 28 October: port 7856 in the ufw allow list; `.well-known` placeholders; pgBackRest repository unencrypted; production IP in README |

No secrets in the tree or in any commit (pattern scan over every blob in history). No SQL injection,
no XSS sink, no SSRF, no shell injection found; see "Verified sound" at the end.

---

## Critical

### 1. Schema/migration drift: production runs code whose tables and enum values do not exist

- `packages/db/src/schema.ts:2337-2392` defines `sos_report` (table, three indexes, three checks);
  `packages/shared/src/notifications.ts:76` adds `'sos_reported'` to `NOTIFICATION_KINDS`;
  `schema.ts:248` and `:462` declare `user_avatar_key_unique` and `series_artwork_key_unique`.
  None of these has SQL: `grep -l sos_report|sos_reported|avatar_key_unique packages/db/drizzle/*.sql`
  is empty, `meta/0044_snapshot.json` has no `public.sos_report` and its `notification_kind` enum ends
  at `sos_reply`, and `_journal.json` ends at `0044_sos_anonymous`. The 28 October resolution table
  said the unique-index migration was "to be generated before merge"; it was not.
- CI confirms it. Every run on `main` since `05c82e5` is red; the run for `ac28bc6`
  (https://github.com/entrpyc/thp-pwa/actions/runs/40917009389) shows `migrations.test.ts`
  expecting `sos_report`, and eight `account-deletion.test.ts` cases answering **500** because
  `anonymiseNotificationsByActor` runs `update notification ... where kind = 'sos_reported'`, which
  Postgres refuses as an invalid enum value.
- Blast radius on a database at migration 0044:
  - `POST /api/v1/sos/:id/report` → `relation "sos_report" does not exist` → 500; the admin reports
    console joins the table and breaks.
  - **Account deletion** (`DELETE /users/me` and the token flow) → 500 at the notification
    anonymisation step inside the deletion transaction. This is the flow Apple 5.1.1(v) and Google
    Play require.
  - **Every push notification.** `packages/db/src/push.ts:250-255` builds a `values` list from
    `NOTIFICATION_CATEGORY_OF_KIND` (`shared/push.ts:72` includes `sos_reported`) with
    `::notification_kind` casts on every call of `listPushDeliveries`, which `packages/push/src/dispatch.ts`
    runs for every delivery. The cast fails before any row is read, so new-recording, reply,
    announcement and prayer-request pushes all fail, not only reports. The in-app bell is unaffected.
- **This is live.** The Deploy run for `ac28bc6` tagged v1.7.0 and its box step failed, but the
  client bundle served at `https://thp.indepthwebsolutions.com` carries `v1.7.0`, so the restart had
  already happened (the failure was the post-restart verify). Its gate job passed while CI was red,
  which means `skip_ci_gate` was ticked. Note that `verify:production`'s `migrations` check compares
  the journal length with the applied count, so it cannot see this class of drift.
- Fix, in order: (1) generate the missing migration in `packages/db` (`sos_report` with its indexes
  and checks, `ALTER TYPE notification_kind ADD VALUE 'sos_reported'`, the two unique indexes), run the
  db integration suite green, ship it as a patch release; (2) add a CI step that runs
  `drizzle-kit generate` and fails on a non-empty diff, so schema and migrations cannot drift again;
  (3) make `verify:production` compare `information_schema` against the snapshot, or at least run a
  smoke `select` per table named in the latest snapshot; (4) treat `skip_ci_gate` as an incident
  action: require the approver to write the reason into the run, and look at why it was used here.

---

## High

### 2. Anonymous prayer requests can be de-anonymised

Three independent channels, all confirmed in code.

- **Block oracle.** `packages/db/src/sos.ts` applies `noBlockBetween(viewerId, sosSignal.authorId)`
  in `listSosSignals` (`:171`), `countOpenSosSignalsByUrgency` (`:193`) and `findSosSignalForViewer`
  (`:225`) regardless of `anonymous`; `packages/db/src/notifications.ts:206` does the same for the
  `sos_raised` audience. Blocks are free, instant, unilateral and reversible
  (`POST/DELETE /users/me/blocks/:id`, any member id). A member who wants to know who raised an
  anonymous request blocks a candidate, reloads the board, and sees whether the request vanished;
  unblock, next candidate. In a group of a hundred this is minutes. The `sos_raised` push is the
  passive form of the same oracle.
- **The author's own replies.** `packages/web/src/server/sos/service.ts:438-452` (`describeReply`)
  always emits the real author; only `describeSignal` masks. An anonymous author who writes
  "thank you all" in their own thread is named, with avatar and the same `author.id` their public
  notes carry. Nothing warns them.
- **Thread-reply notification title** is built from `replier.displayName` without the anonymous
  check (`notifications/service.ts`, `notifySosThreadReply`).
- Fix: for `anonymous = true`, apply only the author-side block (rows where the author blocked the
  viewer) to the signal, the counts and the audience insert, never the viewer-side one; in
  `describeReply` and the thread-reply title substitute `ANONYMOUS_AUTHOR` when
  `reply.authorId === signal.authorId && reader.id !== signal.authorId`; add integration tests
  (A blocks B, B's anonymous signal still shows for A; the author's reply shows as anonymous).

---

## Medium

### 3. CSRF and login-CSRF from sibling hosts under the parent domain
- `packages/shared/src/auth.ts:10` names the cookie `thp_session`, not `__Host-thp_session`;
  `server/auth/session.ts:115-126` sets `SameSite=Lax`, `Path=/`, no `Domain` (good) but nothing
  stops another host under `indepthwebsolutions.com` from setting a `thp_session` cookie with
  `Domain=indepthwebsolutions.com`, and `readSessionCookie` (`:79-89`) takes the first match.
  `server/api/route.ts` checks neither `Origin`, `Sec-Fetch-Site` nor `Content-Type`
  (grep over `packages/web/src` is empty); every handler calls `request.json()`, which parses a
  `text/plain` simple request without preflight.
- `deploy/nginx/thp.conf` states the box serves other sites; those share the registrable domain, so
  `SameSite=Lax` does not isolate them. Any XSS or compromise on a sibling site can (a) issue
  state-changing API calls as a signed-in member (write notes, raise or close prayer requests,
  block, delete the account if the password is known) and (b) toss an attacker session cookie so
  the victim unknowingly writes private notes into the attacker's account.
- Fix: rename the cookie to `__Host-thp_session` (forces Secure, Path=/, no Domain); in `apiRoute`
  for every non-GET/HEAD request require `Sec-Fetch-Site` to be `same-origin` or `none` (fallback:
  `Origin` equal to `readAppOrigin()`), and require `Content-Type: application/json` where a body is
  read. Both are small, central changes.

### 4. Presigned PUT remains usable after verification
- `packages/media/src/s3-store.ts:41-55` signs only `content-type`; `store.ts:148` gives the grant
  3600 s; avatar (`accounts/avatar.ts:102-150`), note images (`notes/images.ts:161-185`) and series
  artwork (`series/service.ts:342-388`) `head()` the object once, check ≤ 4 MB and image type, and
  commit the key. The same URL then accepts another `PUT` with the same `Content-Type` for the rest
  of the hour; nothing re-checks size on read, and artwork grants are 48 h cacheable.
- Impact: unbounded storage and egress on R2 at the price of ten avatar grants per hour; oversized
  "images" pushed to every client; and a note image can be replaced *after* a moderator looked at
  it. The worker side of this was closed on 28 October (finding 9 there); the image side was not.
- Fix: sign `Content-Length` (`ContentLength` on the command plus `'content-length'` in
  `signableHeaders`) and store size and ETag at commit, or copy the verified object to a fresh
  immutable key with `CopySourceIfMatch` and delete the staging key. Shorten image grants to a few
  minutes.

### 5. Members can block admins and hide from moderation
- `server/blocks/service.ts:51-66` forbids only self-blocking. `noBlockBetween` is symmetric and
  applied with the admin as viewer in `listNotesForReader`, `listSosSignals`, `findSosSignalForViewer`,
  `listSosReplies`, `listReactionsForNotes`. `closeSignalFor` and `deleteReplyFor` go through
  `requireVisible` (`sos/service.ts:334`), so a blocked admin gets 404 on the normal route; only
  `removeSignalFor` and report resolution bypass it.
- Fix: refuse blocking an admin, or skip the viewer-side predicate when the actor holds the
  corresponding `*.moderate` permission.

### 6. Moderation record and SOS history are destroyed by cascades
- `schema.ts:2340` cascades `sos_report.signal_id`; `reports/service.ts:117-140` resolves the report
  and then hard-deletes the signal, so the "removed" outcome erases its own report, every other
  member's replies, praying rows and bell entries. Note reports keep a tombstone; SOS reports keep
  nothing. Resolve and remove are not in one transaction.
- `schema.ts:2205,2297` cascade `sos_signal.author_id` and `sos_reply.author_id` on user delete;
  `account-deletion.ts:34-86` reassigns notes to the placeholder but not SOS, so a deleted member's
  requests (with everyone's replies) and all their replies on other threads vanish, and
  `anonymiseNotificationsByActor` (`notifications.ts:200-232`) rewrites every kind except
  `sos_raised`, whose title embeds the display name.
- Fix: soft-delete signals (`removed_at`, `removed_by`, filtered in reads) or `set null` with a
  description snapshot on the report; one transaction for resolve+remove; reassign SOS authorship
  to the placeholder; include `sos_raised` in the anonymiser.

### 7. Search cache outlives visibility changes
- `server/search/service.ts:35-52,75` caches full hit rows (passage text, titles) per actor and
  query until the next Monday (`cache.ts:23-28`); `.clear()` has no caller. The DB predicate
  `embeddingVisibleTo` is correct and is bypassed. Unpublish, note deletion, moderation and new
  blocks take up to a week to reach anyone who already ran the query.
- Fix: clear the cache on (un)publish, note delete/moderate and block create, or key entries with a
  visibility generation counter; or cache ids only and re-filter on read.

### 8. No per-actor budgets on social writes; unthrottled password check on self-deletion
- `server/api/actor-limits.ts:37-44,83-100` budgets only feedback, upload grants and search.
  `createNote`, `replyFor` (`sos/service.ts:198-231`, two notifications per call),
  `raiseSignalFor` (limit is ten *open*; close-and-raise is free), `reportNote`, blocks: none.
  `POST /sync` runs `createNote` up to 200 times per request. Each reply stores a notification and
  pushes to the author; each raise pushes to the whole group.
- `app/api/v1/users/me/route.ts:27-36` → `accounts/deletion.ts:78-91` verifies the password per call
  with no budget: a session holder (shared device, or finding 3) has an unbounded online argon2
  oracle whose success hard-deletes the account.
- Fix: add `note-write`, `sos-write`, `report`, `block` and `self-delete` budgets to
  `ACTOR_BUDGETS` and spend them in the services (inside `applyEntry` for sync so offline and online
  share one bucket); collapse repeated reply notifications per recipient, signal and window.

### 9. Timing oracle on the two "uniform answer" public routes
- `server/password-reset/service.ts:118-177` and `account-deletion/service.ts:101-131` return the
  same `{requested:true}` for every address, but a known address performs an insert and an awaited
  SMTP round-trip first; an unknown one returns in milliseconds. The per-IP budget (5 per 15 min)
  bounds throughput, not the leak.
- Fix: send the mail off the request path (queue or fire-and-forget with error logging) so every
  outcome returns at the same point, or run a comparable decoy path for unknown addresses.

### 10. Android Auto Backup carries the session and the offline corpus
- `packages/shell/android/app/src/main/AndroidManifest.xml:5` `android:allowBackup="true"`, no
  `fullBackupContent` or `dataExtractionRules`. The app's data directory holds the WebView cookie
  jar (the session), IndexedDB (`thp-offline`: downloaded teachings with other members' notes) and
  `files/downloads/<user>/…` (`client/offline/shell-store.ts:36-39`). A restore onto another device
  carries a live session.
- Fix: `android:allowBackup="false"`, or exclusion rules for `app_webview`, `databases` and
  `files/downloads`.

### 11. Offline page cache serves personal pages without identity; cache keys collide
- `public/sw/offline.js:43` lists `/profile` and `/notifications` among cacheable member pages;
  `handlePage` (`:127-142`) stores any 200 `basic` response and serves it when the network fails,
  with no check against the active account; `profile/name-card.tsx:105` renders the member's email
  into that page. The cache is purged only on sign-out or on another *successful* sign-in; a
  session that merely expired leaves A's profile, notifications and note threads readable offline
  by whoever holds the device. This undoes part of the 28 October fix that removed the email from
  IndexedDB.
- `pageKey` (`:84-89`) distinguishes the RSC copy with a `#rsc` fragment, but the Cache API ignores
  fragments, so the HTML and RSC entries overwrite each other; `warm()` writes HTML then RSC, so a
  cold offline navigation to a warmed teaching likely receives the RSC payload. Functional, not
  security; unverified in a browser.
- Fix: drop `/profile` and `/notifications` from the cacheable prefixes (warm `/profile/downloads`
  explicitly), check `activeUser` in IndexedDB before serving a cached page, expire cached pages
  with the session; move the RSC marker into the query string or a second cache.

### 12. Transcription spend is unbounded per job and partly unledgered
- `worker/src/run-job.ts:103-136` checks the ceiling only before a job. Deepgram prices by audio
  duration (`asr/deepgram.ts:37,230-232`); a 200 MB low-bitrate upload is tens of hours, about $15
  against a $2 ceiling, and `generate_draft` then makes one MiniMax call per chapter.
  `deepgram.ts:88-126` aborts after 30 min with a plain `TranscriptionError`; `transcribe.ts:117-121`
  rethrows it without `PaidFailure`, so the charge never reaches the ledger. `spend.ts:33-46` also
  ignores `running` rows, so concurrent claims all pass the check.
- Admin-only trigger (uploads), so this is operator error or a stolen admin session.
- Fix: measure duration in `process_audio` and store it; refuse `transcribe` when the estimate
  exceeds the remaining ceiling; throw `PaidFailure` with the estimate on timeout; count `running`
  jobs at a reserved cost.

---

## Low

### 13. Session lifetime and credential hygiene
- `session.ts:24-31,63-65`: every request after an hour extends `expiresAt` by 30 days with no
  absolute cap. Only password reset revokes all sessions; there is no change-password or
  sign-out-everywhere route. Fix: absolute cap (for example 90 days from creation); add
  `POST /users/me/password` requiring the current password and revoking other sessions.

### 14. Note-image keys are not bound to the grantee
- `notes/images.ts:161-185` checks prefix, existence, size, type and single use, not who was granted
  the key (avatars do, `avatar.ts:124-137`). Keys are random uuids, so this needs a leaked grant;
  `note.image.granted` logs the key. Fix: record `(actor, key)` at grant time and require a match.

### 15. Deactivated accounts can complete self-deletion
- `account-deletion/service.ts:111` checks `deletedAt` only. An admin who deactivates an account for
  moderation cannot stop the member erasing their private notes. May be intended for store
  compliance; decide and document.

### 16. Numeric and array bounds
- `flow-tracker/service.ts:141-145` parses an arbitrarily long `recordingIds` array before dedupe
  (nginx allows 25 MB bodies). `playback/state.ts:132-136`: `positionMs` and `durationMs` have no
  upper bound; an out-of-range integer raises 22003, which `route.ts` does not map (only 22P02), so
  it answers 500. `playback.ts:58` accumulates `listened_ms` with a 1 h per-write cap but no total,
  so a 200-entry sync adds 200 h and forces completion. Fix: cap array length, bound the millisecond
  fields, cap `listened_ms` relative to duration, map 22003 to `invalid_input`.

### 17. Check-then-act races without a constraint
- Duplicate reports (`notes/service.ts:297-314`, `sos/service.ts:233-251`, no partial unique index
  on reporter+target where unresolved); SOS open limit (`sos/service.ts:100-111`); outbox sync
  (`offline/service.ts:127-186`, `sync.ts:52-70`) reads receipts, applies, then inserts the receipt
  with `onConflictDoNothing`, so two concurrent flushes create the note twice. Fix: partial unique
  indexes; insert the receipt first with `returning` and skip on no row.

### 18. Flow-session items survive unpublish
- `flow-tracker.ts:426-440` snapshots chapter title, summary and question; `listFlowSessionItems`
  (`:495-528`) and `listFlowSessionTeachings` join `recording` with no `published_at` gate. Fix:
  filter or mark stale.

### 19. Personal data and provider detail in logs and PostHog
- `server/mail/mailer.ts:56-66` logs `to` and `subject` on every send and failure; the feedback
  subject is member-written. Provider error bodies (up to 400 chars) from Deepgram, MiniMax and
  OpenAI flow into `job.error`, the log and PostHog; a Deepgram error that echoes the submitted URL
  would carry a 2 h presigned GET (unverified format). Fix: log a message kind and a hashed address;
  strip query strings and `X-Amz-*` from provider text before it leaves the worker.

### 20. ffmpeg wrapper and storage growth
- `audio/ffmpeg.ts:126-131,369` keeps all stderr of the 30 min loudnorm pass in one string;
  `:406-412` reads the whole rendition into memory before upload; `:210-261` passes no
  `-protocol_whitelist`, `-f`, `-probesize` or `-analyzeduration`, so a playlist disguised as audio
  can make ffmpeg open other paths (modern defaults block most of it; depends on the installed
  build). `process-audio.ts:101,126` mints a new `playback/` key per reprocess and never deletes the
  old one; previews likewise. Admin-only triggers. Fix: keep a bounded stderr tail, stream the
  upload, add `-nostdin -protocol_whitelist file` and an `ffprobe` format allow-list, delete
  superseded keys or add a lifecycle rule.

### 21. Push sends without timeout inside request handlers
- `push/src/fcm.ts:55-62,82-101` and `web-push.ts:26` have no timeout (APNs has 15 s);
  `dispatch.ts:81-96` drains 16 wide and `notifications/service.ts` awaits `deliverPush` in eleven
  request paths. A hung provider stalls the admin's publish or a member's reply. Fix:
  `AbortSignal.timeout(10_000)`, and fire delivery after the response.

### 22. Client-side residue and path check
- `public/sw/push.js:30-33` and `push-shell-listener.tsx:44-45` accept any path starting with `/`
  but not `//`; `new URL('/\\evil.example', origin)` resolves off-origin. Payloads are server-built,
  so this needs a server compromise. `offline/manager.ts:184-188,417-423` leaves the previous
  account's `session:<id>` meta when a different account activates. `offline/schema.ts:109-113`
  keeps other members' public notes inside each download across sign-out. Fix: compare
  `new URL(href, origin).origin` with the page origin; delete foreign `session:*` on activate; clear
  `notes` in `deactivate()`.

### 23. Deploy pipeline
- `skip_ci_gate` was used for v1.7.0 while CI was failing, which is how finding 1 reached
  production. `DEPLOY_SSH_KEY` is a repository-level secret (reachable by any workflow anyone with
  write access pushes); its forced command bounds the damage to redeploying any published tag,
  which includes rolling back to a release with a known bug. Fix: an environment-scoped secret with
  a second approval, or at least audit-log the gate skip; have `deploy-ssh-entry.sh` refuse tags
  older than the one currently checked out unless a second argument says rollback.

### 24. Existence oracles
- `notes/service.ts:237-244,295-301` loads a note before authorising, so a foreign private note id
  answers 403 rather than 404. `blocks/service.ts:95-103` answers 404 vs 200 for arbitrary user ids
  and lets a member block an admin. UUIDs make enumeration impractical.

---

## Info

### 25. Process binding
- `next start` binds every interface; `ufw` and the loopback `proxy_pass` keep `:3000` private from
  outside, but any other process on the shared box can reach it directly and spoof `X-Real-IP`
  (`server/api/client-address.ts` trusts it). Start with `-H 127.0.0.1`.

### 26. Headers and relay
- `deploy/nginx/thp.conf:87-95` forwards every path under `/relay/` to PostHog; restrict to the
  paths the client uses (`/e/`, `/decide/`, `/array/`, `/static/`). The CSP (`proxy.ts`) has no
  `report-to`; `style-src 'unsafe-inline'` is documented and no CSS injection vector exists today.

### 27. Third-party egress
- Private notes and every search query are embedded through OpenAI (`embed-recording.ts:296-298`,
  `search/service.ts:101`); APNs and FCM payloads carry note excerpts and prayer-request text in the
  clear (`fcm.ts:88`, `apns.ts:80`), unlike Web Push which is end-to-end encrypted. Privacy-notice
  points; consider title-only store pushes.

### 28. Dependencies
- `npm audit`: 4 moderate, all via `drizzle-kit` → `@esbuild-kit` → `esbuild`, development only
  (fix is a `drizzle-kit` downgrade). `next` 16.4.3, `nodemailer` 10.3.1 in the lockfile. The local
  checkout's `node_modules/nodemailer` is still 7.0.13, so the last `npm ci` predates PR #66; the
  box runs `npm ci` on deploy and is unaffected.

### 29. Carried over from 28 October
- Port 7856 still accepted by `verify-production.ts:481`; `.well-known` files still carry
  placeholders; pgBackRest `repo1-cipher-type=none`; README names the production IP.

---

## Verified sound

- **28 October fixes present on `main`** (each re-read): next/sharp upgrade and
  `images.unoptimized`; sudoers pinned with a root-owned drill helper; avatar and artwork key prefix
  and holder checks (app level only, see finding 1 for the index); nodemailer 10 in the lockfile;
  nonce CSP with `strict-dynamic`, `frame-ancestors 'none'`, `form-action 'self'`, nosniff, XFO,
  Referrer-Policy, Permissions-Policy, HSTS, `server_tokens off`, token paths out of the access log;
  `embeddingVisibleTo` applies blocks through the note row; failed-step spend ledgered; worker size
  re-check and stream cut; sweep reclaim cap; drafts per account and cleared on sign-out; IndexedDB
  session copy without email; push host allow-list, token shape checks, APNs path encoded; token
  routes behind a per-caller budget; 22P02 mapped; sync requires uuid ids; blocks re-pointed on
  deletion; `PATCH /users/:id` authorises both halves first; DB timeouts and off-loopback TLS;
  `requireTLS`; no `actorEmail` in logs; page cache purged on sign-in; actions SHA-pinned;
  `.env` parsed not sourced; chapter text clipped; compose on loopback; self-service sign-up removed
  (route, service and limiter deleted; allowlist has 10 entries; route sweep asserts it).
- **API gate.** Every route under `/api/v1` is wrapped in `apiRoute(access, …)` except the
  deliberate `diagnostics/unguarded`, which returns 401 unless a production-refused flag is set; the
  catch-all requires a session; the policy table denies by default, is exhaustive over roles, and
  ownership rules compare `ownerId` inside `can()`; admin operations are `member: false`; last-admin
  guard locks `FOR UPDATE`; deactivated users lose sessions on the next request; every body field
  has a type check and a length or range cap; no `formData()`, no Server Actions, no redirect
  parameter, no server-side fetch of a user URL.
- **SQL.** Every `sql.raw` interpolates a compile-time constant; user text reaches
  `websearch_to_tsquery` and `ts_headline` as parameters; identifiers and sort orders are fixed;
  vector literals are bound then cast.
- **Visibility.** Member reads of recordings, transcripts, chapters, scripture, playback, download,
  notes, highlights, cross-references, mind maps, flow start and series all pass through
  `findVisibleRecording`/`listVisibleRecordings`; private notes gated by `noteReadableBy` and a CHECK
  forcing replies public; anonymous SOS masked in list, detail, counts, praying names, push payloads
  and admin report rows (the gaps are finding 2).
- **Tokens and sessions.** 256-bit tokens stored hashed; atomic conditional-update claims inside
  transactions backed by unique indexes; reset revokes all sessions; cookies HttpOnly, Secure
  outside development, `SameSite=Lax`; constant-time decoy verify on sign-in; per-IP and per-account
  budgets spent before the lookup.
- **Client.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `javascript:` href, `srcDoc`,
  `target="_blank"` or `postMessage` listener; all user and model text rendered as JSX text; every
  variable `href`/`src` from shared path helpers or server-signed URLs; `createObjectURL` only on
  self-created blobs; analytics opt-out by default, same-origin relay with cookie and referer
  stripped, `{ role }` as the only person property, off outside production; Capacitor `server.url`
  pinned, cleartext only for an `http://` dev override, no `allowNavigation`, no mixed content, no
  WebView debugging, iOS entitlements limited to applinks and aps; transcript file names sanitised.
- **Worker.** ffmpeg via `spawn` argv with integer-validated knobs and `mkdtemp` directories;
  provider endpoints constant; Bible URL from a fixed book table and validated chapter; model output
  must arrive as a forced tool call, is canonicalised, clipped and never chooses a record or account;
  provider keys only in headers, never logged; ceiling checked before every paid step; timeouts on
  Deepgram, MiniMax, OpenAI, Bible, APNs, heartbeat and ffmpeg.
- **Mail.** Templates escape every interpolated value; `from` and host env-only; addresses
  regex-checked single addresses; feedback length-bounded and sent only to the configured inbox.
- **Infra.** nginx proxies on loopback with correct forwarded headers; deploy key forced to a
  tag-only command; deploy refuses dirty trees and non-tag checkouts; source maps removed from the
  box; `.env` mode 600 and gitignored; no secret in the tree or in any historical blob; compose on
  loopback; pgBackRest credentials isolated from the media credential by a check.

## Suggested order of work

1. Finding 1 today: generate and ship the missing migration as a patch release, then add the
   drift guard to CI.
2. Finding 2 (one predicate change plus the reply mask), then finding 3 (`__Host-` cookie and the
   `Sec-Fetch-Site` check in `apiRoute`).
3. Findings 5, 6 and 7 together: they are all "moderation and visibility decisions do not reach
   every read path".
4. Findings 4, 8, 9 and 12: budgets, grant binding and spend bounds.
5. Findings 10 and 11 before the next store submission.
6. The Lows as a hardening pass; decide the Info items in the privacy notice.

## Resolution (29 October 2026, branch `security-improvements`)

| # | Status | What changed |
|---|--------|--------------|
| 1 | Fixed | Migration `0045_sos_report` (the table, its indexes and checks, `ALTER TYPE notification_kind ADD VALUE 'sos_reported'`, the two unique indexes) generated from the schema. CI runs `drizzle-kit generate` and fails on any file it writes. `verify:production`'s `migrations` check now compares the latest snapshot's tables and enum labels against `information_schema`/`pg_enum`. `skip_ci_gate` requires a written `skip_ci_gate_reason`, carried into the run summary and the release notes. Ship as a patch release: production is still at 0044. |
| 2 | Fixed | `sos.ts` reads an anonymous signal, and its author's replies, under the author-side block only (`blockPlacedAgainstViewer`); the `sos_raised` audience insert does the same; `describeReply` and the praying list mask the anonymous author; the thread-reply title says "Someone" when the replier is the anonymous author. Integration test added. |
| 3 | Fixed | `apiRoute` refuses non-GET requests whose `Sec-Fetch-Site` is cross-site, whose `Origin` is not this site's, or whose body is not `application/json`. The cookie is `__Host-thp_session` wherever it is `Secure` (plain name in development only). Integration test added. |
| 4 | Fixed | Avatar, note-image and artwork grants sign `Content-Length` and last ten minutes (`IMAGE_UPLOAD_GRANT_SECONDS`). The recording grant is unchanged. Size and ETag are not stored at commit. |
| 5 | Fixed | A caller holding `sos.moderate` reads past blocks placed against them (`visibleAcrossBlocks`); their own blocks still apply. Blocking an admin stays allowed, as the policy module decided. Notes moderation already reached a note by id. |
| 6 | Fixed | Removing a signal is a mark (`removed_at`, `removed_by`; migration `0046`), filtered from every member read; its bell entries are deleted explicitly; the report, replies and praying rows survive. Resolve and remove run in one transaction. Account deletion re-points `sos_signal.author_id` and `sos_reply.author_id` at the placeholder and rewrites `sos_raised` titles. |
| 7 | Fixed | `clearSearchCache()` on publish, unpublish, note edit, note delete/moderate and block creation. |
| 8 | Fixed | Budgets `note-write` (120/h, shared with sync), `sos-write` (40/h), `report` (20/h), `block` (30/h), `self-delete` (10/h, spent before the hash check). Reply notifications are not collapsed per window. |
| 9 | Fixed | Password-reset and deletion requests answer after parsing the address; the lookup, row and send run after the response. |
| 10 | Fixed | `android:allowBackup="false"`. |
| 11 | Fixed | `/profile` and `/notifications` are no longer cacheable (`/profile/downloads` is); a cached page is served only while `thp-offline.meta.activeUser` names an account; the RSC marker is a query parameter and the page cache is `thp-pages-v2`. |
| 12 | Partly | A transcription is refused before the provider call when its size-estimated cost would pass the ceiling; a Deepgram timeout is ledgered at that estimate (`TranscriptionTimeoutError`). Running jobs are not counted: worker concurrency is pinned to 1. |
| 13 | Partly | Sessions expire ninety days after sign-in whatever the rolling window (`SESSION_ABSOLUTE_LIFETIME_MS`). No change-password or sign-out-everywhere route yet. |
| 14 | Fixed | Note-image keys are minted under `note-images/<member id>/`; a write accepts a new key only under the writer's own prefix. |
| 15 | Decided | Deactivated accounts may complete self-deletion; documented in `account-deletion/service.ts`. |
| 16 | Fixed | `recordingIds` capped at 500 before parsing; `positionMs`/`durationMs` capped at 24 h; `listened_ms` capped at twice the known duration (a day when unknown); SQLSTATE `22003` answers `invalid_input`. |
| 17 | Fixed | Partial unique indexes on open reports per reporter (notes and SOS, migration `0046`), read as "already reported"; the SOS cap is counted and written under a per-author advisory lock. Outbox receipts unchanged: a second concurrent flush of one `clientId` can still create the note twice. |
| 18 | Fixed | Flow-session items and teachings are gated on `recordingIsPublished()`. |
| 19 | Fixed | The mailer logs a recipient digest and the subject length; provider error bodies lose URL query strings before they leave the worker (`@thp/shared/observability/redact`). |
| 20 | Partly | `-nostdin -protocol_whitelist file` on every ffmpeg input; stderr bounded at 64 KB. Renditions are still read whole into memory and superseded keys are not deleted (the store has no delete outside the two image prefixes). |
| 21 | Partly | 10 s timeouts on FCM (token and send) and Web Push. Delivery is still awaited inside the request. |
| 22 | Partly | Push landing paths are resolved and origin-compared in the worker and the shell listener; foreign `session:*` meta is deleted on activate. Downloads still keep other members' public notes across sign-out. |
| 23 | Fixed | `skip_ci_gate_reason` (see 1); `deploy-ssh-entry.sh` refuses a tag below the deployed one unless the request says `rollback`. The deploy key remains a repository-level secret. |
| 24 | Noted | No change: uuids make enumeration impractical and the 403/404 split is a documented decision. |
| 25 | Fixed | `next start -H 127.0.0.1` in `ecosystem.config.cjs`. |
| 26 | Fixed | `/relay/` forwards only the PostHog client's paths; everything else is 404. No CSP reporting endpoint. |
| 27–28 | Noted | No code change. |
| 29 | Partly | `verify:production` now reports port 7856 as unexpected (delete the ufw rule on the box); the production IP is out of the README. `.well-known` placeholders and the pgBackRest cipher need material only the operator holds. |
