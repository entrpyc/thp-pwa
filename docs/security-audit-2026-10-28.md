# Security audit — Teaching Hub (28 October 2026)

Scope: the whole repository at branch `cyber-security-audit`, including infrastructure configuration
(`deploy/`, `docker-compose.yml`, `ecosystem.config.cjs`, `.github/workflows`, `scripts/`), the web
app (`packages/web`), the data layer (`packages/db`), the worker and external integrations
(`packages/worker`, `packages/media`, `packages/push`, `packages/bible`, `packages/embed`), the client
and offline code, the Capacitor shell, and third-party dependencies (`npm audit`).

Method: manual code review of every security-relevant path, cross-checked by four independent
reviewers (route authorization, DB/SQL, worker/external, client/XSS). Nothing was executed against a
live system and nothing was changed. Every finding cites the file and line it was read from.

Severity: **Critical** = remote compromise with no or trivial preconditions. **High** = compromise or
large data exposure with a realistic precondition. **Medium** = integrity/privacy/cost impact for one
or more members, or a missing control that turns a future bug into a compromise. **Low** = hardening,
limited impact, or needs an unlikely precondition. **Info** = worth knowing, no action strictly needed.

---

## Summary

| # | Severity | Finding |
|---|----------|---------|
| 1 | High | `next@16.3.1` carries 13 published advisories, 4 of them unauthenticated RCE |
| 2 | High | Self-service sign-up with no admin approval or email verification gives any stranger full member access to a private group's content, including prayer requests |
| 3 | High | sudoers lets the `thp` service user run `psql`, `tee`, `touch`, `pg_ctl` as `postgres` without a password: any RCE in web or worker becomes a Postgres superuser |
| 4 | Medium | Avatar finalise accepts any object key: a member can alias and then delete another member's avatar, or alias any image in the bucket |
| 5 | Medium | `nodemailer@7.0.13` carries 20 advisories (SMTP injection, address-parser DoS, TLS validation) |
| 6 | Medium | No browser security headers at all (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy) |
| 7 | Medium | Search ignores member blocks: a blocked member reads the blocker's public notes through search |
| 8 | Medium | Spend ceiling counts only succeeded jobs: provider cost of failed steps is never ledgered |
| 9 | Medium | A finalised upload can be overwritten through the still-live presigned PUT; worker downloads with no size bound |
| 10 | Medium | Boot sweep re-queues crashed jobs with no attempt cap (crash loop, repeated provider spend) |
| 11 | Medium | Note drafts in `localStorage` and the offline IndexedDB survive sign-out on a shared device |
| 12 | Low | Push-subscription upsert reassigns an endpoint to whoever registers it last; web endpoints only need to be `https://` (limited SSRF) |
| 13 | Low | Token-completion routes have no rate limit; account-deletion completion is a password oracle for a token holder |
| 14 | Low | Non-UUID ids reach Postgres and answer 500 (error-tracker noise) |
| 15 | Low | Deleting a member cascades away blocks others held against them |
| 16 | Low | `PATCH /users/:id` writes the display name before refusing the role change |
| 17 | Low | DB connection: no TLS requirement, no statement or idle-in-transaction timeouts |
| 18 | Low | SMTP: no `requireTLS` on non-465 ports |
| 19 | Low | Member emails written to pm2 logs on most audit lines |
| 20 | Low | `verify:production` tolerates an undocumented open firewall port (7856) |
| 21 | Low | Service-worker page cache is purged only on explicit sign-out |
| 22 | Low | Deploy pipeline: `skip_ci_gate`, unpinned actions, no tag protection noted, `source .env` in a shell script |
| 23 | Low | Model-generated chapter text reaches members unreviewed and unbounded in length |
| 24 | Low | Dev-only dependency advisories (vitest, vite, esbuild, drizzle-kit, @capacitor/cli) |
| 25 | Info | Private notes are embedded through OpenAI; privacy notice should say so |
| 26 | Info | `.well-known` files still contain placeholders |
| 27 | Info | Development compose binds Postgres and MinIO on all interfaces with fixed credentials |
| 28 | Info | pgBackRest repository unencrypted (documented decision) |

What was verified as sound is listed at the end; it is a long list and the overall posture is good.

---

## High

### 1. Next.js 16.3.1 has published unauthenticated RCE advisories
- `packages/web/package.json` → `next@16.3.1`. `npm audit` lists 13 advisories for the 16.0.0–16.4.0
  range, among them GHSA-2xp9-vwfh-vxw4 and GHSA-2464-fhr4-w9xw (RCE in the image optimisation API
  with AVIF / SVG input), GHSA-vcvr-r3jv-pc5j (RCE in `next/og`), GHSA-673q-mjm6-r5xr (RCE in
  `use cache`), GHSA-cjq9-62q9-8jv4 (SSRF in image optimisation), GHSA-p3m5-59mp-jv5r (DoS via server
  actions) and several cache-poisoning issues. Also `sharp@0.35.3` (bundled by Next) carries libheif
  and librsvg advisories.
- Exposure here: the app does not use `next/image`, `next/og`, `use cache` or server actions (grep is
  empty), and `next.config.ts` configures no remote image patterns, so the most dangerous paths are
  not reachable with attacker-supplied bytes today. The `/_next/image` endpoint is still served by
  default, and the production box is Linux (the Windows-only RCE does not apply).
- Fix: upgrade `next` to the patched release `npm audit` reports (`fixAvailable: true`), which also
  pulls the fixed `sharp`. Until then, disable the optimiser (`images: { unoptimized: true }`) since
  nothing uses it.

### 2. Open self-registration with no gate into a private group
- `packages/web/src/server/auth/allowlist.ts:629-636` puts `POST /api/v1/auth/sign-up` on the public
  list; `packages/web/src/server/auth/sign-up.ts:52-54` states there is no email verification because
  "the real gate is a person an admin recognises". No such gate exists in code: there is no approval
  flag on `user` (`packages/db/src/schema.ts`), and every new row is a live `member`.
- A member may read the whole published library, every public note with author names and avatars,
  the SOS/prayer-request board (`policy.ts`: `sos.read` is both roles), reply, react, report, and
  register push devices. Prayer requests are health- and belief-adjacent personal data under GDPR
  Article 9; today any anonymous person on the internet can create an account and read them, and
  re-register after being deactivated.
- The per-IP / whole-route sign-up limiter (`sign-up-limits.ts`) bounds bulk registration, not access.
- Fix (any one): require an invitation (the invitation flow already exists and is the stated model),
  or add an `approved_at` column that an admin sets before `findLiveSessionByTokenHash` resolves the
  account, or at minimum verify the email and restrict sign-up to an allow-listed domain. If open
  registration is a product decision, say so in the privacy notice and treat the SOS board as public.

### 3. sudoers turns any RCE into a Postgres superuser
- `deploy/sudoers/thp:20-24`: `thp ALL=(postgres) NOPASSWD: /usr/bin/pgbackrest, /usr/bin/psql,
  /usr/lib/postgresql/17/bin/pg_ctl, /usr/bin/tee, /usr/bin/test, /usr/bin/touch` with **no argument
  restriction**.
- The web and worker processes run as `thp` (`ecosystem.config.cjs`). Code execution in either (for
  example via finding 1) therefore gives: `sudo -u postgres psql` → `\!` shell as the `postgres` OS
  user, `COPY ... TO PROGRAM`, superuser access to every database and role on the box (the
  README's monitoring role, pg_hba.conf), `sudo -u postgres tee` → overwrite any file postgres owns
  (`pg_hba.conf`, `postgresql.conf`, `~postgres/.ssh/authorized_keys`), `pg_ctl` → start a cluster
  from any data directory with any options, and `pgbackrest` with any arguments → read the R2
  backup credentials path and `restore --delta` over the live cluster.
- The file's own comment says it is "not `ALL`" to avoid a root shell; it is a postgres shell.
- Fix: pin arguments in the aliases to exactly what `scripts/restore-drill.sh` runs, e.g.
  `/usr/bin/psql -Atc "show port"`, `/usr/bin/psql -p 5433 -Atc "select pg_is_in_recovery()"`,
  `/usr/bin/pgbackrest --stanza=thp --pg1-path=/var/lib/postgresql/restore-drill --type=default
  restore`, `pg_ctl -D /var/lib/postgresql/restore-drill *`, and replace the `tee`/`touch` writes
  with a single root-installed helper script. Better: move the drill to a dedicated `thp-drill`
  account or a root cron, so the service user needs no `sudo` at all; keep the `verify:production`
  checks (`certbot renew --dry-run`, `ufw status`, `sshd -T`) as they are (fixed arguments).

---

## Medium

### 4. Avatar finalise accepts any object key (alias and delete another member's avatar)
- `packages/web/src/server/accounts/avatar.ts` `parseKey` only checks the key is a non-empty string
  ≤ 512 chars; `setAvatar` then `head()`s the key, checks size and image type, and writes it to the
  caller's row. There is no `avatars/` prefix check, no record that the caller was granted that key,
  and no uniqueness on `user.avatar_key` (`packages/db/src/accounts.ts`). Compare note images, which
  enforce prefix and single use (`notes/images.ts:102,149`).
- Keys are discoverable: every public note and SOS payload carries `authorAvatarUrl`, a presigned
  path-style URL whose path is `/<bucket>/avatars/<uuid>.<ext>` (`s3-store.ts`, `forcePathStyle`).
- Attack: member B sets `PUT /api/v1/users/me/avatar {"key":"avatars/<A's key>"}`, then deletes their
  own account (`accounts/deletion.ts` → `mediaStore().deleteAvatar(current.avatarKey)`, which only
  checks the `avatars/` prefix in `s3-store.ts`). A's avatar object is gone and A's row dangles.
  Because sign-up is open (finding 2), B can repeat. Variants: `head()` is an existence/size/type
  oracle for any key; B can alias any `artwork/` or `note-images/` object as their avatar. The same
  unrestricted `parseArtworkKey` exists at `series/service.ts:434-443` (admin-only).
- Fix: require `key.startsWith(AVATAR_KEY_PREFIX)`; record granted keys per actor and accept only a
  key that actor was granted; add a unique index on `user.avatar_key`; apply the same to series
  artwork.

### 5. nodemailer 7.0.13 advisories
- 20 advisories (fix: `nodemailer@10.2.1`, major): SMTP command injection via `envelope.size` and
  transport name, CRLF in `List-*` headers, address-parser quadratic DoS, recipient-domain bypasses,
  OAuth2 TLS validation, DNS-cache cross-tenant servername reuse.
- Exposure here is reduced: `from` and host are env-only, subjects are escaped and nodemailer strips
  CR/LF in header values, and recipient addresses pass `EMAIL_SHAPE` (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`),
  which blocks a second `@` but not commas or quotes; a crafted address could reach the address parser
  through sign-up, password reset or invitations. The upgrade is the fix.

### 6. No browser security headers
- `packages/web/next.config.ts` `headers()` sets only the AASA content type; `deploy/nginx/thp.conf`
  adds none; grep for CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy is empty across the repo.
- Consequences: no HSTS (first request and downgrade attacks), no `frame-ancestors` (clickjacking
  mitigated only by `SameSite=Lax`), no CSP (the store shell exposes `@capacitor/filesystem` and
  push plugins to the page, so a future XSS becomes native file write/delete and push-token hijack),
  no `nosniff`.
- Fix (nginx or `headers()`): `Strict-Transport-Security: max-age=63072000; includeSubDomains`,
  `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data: <media origin>;
  media-src 'self' blob: <media origin>; connect-src 'self' <media origin>; frame-ancestors 'none';
  object-src 'none'; base-uri 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy` as appropriate. Also `server_tokens off`.

### 7. Search bypasses member blocks
- `packages/db/src/visibility.ts:509-523` (`embeddingVisibleTo`) checks published recording, published
  summary and `owner_user_id is null or = reader`. `search.ts:128-131` uses it and returns
  `embedding.text` (full note text). Public-note embeddings carry no author (`notes.ts:598-613`), so
  `noBlockBetween`, which the notes list applies (`notes.ts:174-196`), is never consulted.
- Attack: after A blocks B, B searches with words from A's note (kind `note`) and reads it with
  recording and timestamp.
- Fix: store `author_user_id` on `embedding` (or join `note`) and add the block predicate inside
  `embeddingVisibleTo`; add cases to `embedding-visibility.test.ts` and `search.test.ts`.

### 8. Spend ceiling ignores the cost of failed steps
- `packages/db/src/spend.ts:59-74` sums `providerMeta->>'costUsd'` **where status = 'succeeded'**.
  `run-job.ts:89-104` writes `failJob` without provider meta. Steps that pay then throw:
  `transcribe.ts:97-103` (Deepgram paid, then low-confidence throw), `generate-draft.ts:112-134`,
  `generate-questions.ts:106-111`, `embed-recording.ts:72-141` (several OpenAI batches).
- An admin re-running a step that always fails after the provider call spends without bound while the
  ledger stays flat; combined with finding 10 this happens without an admin.
- Fix: attach spend to the thrown error, persist it in `failJob`, and sum both `succeeded` and
  `failed` rows.

### 9. Finalised upload can be overwritten; worker download has no size bound
- Presigned PUTs bind only `content-type` (`packages/media/src/s3-store.ts:41-55`), live one hour
  (`store.ts:298`), and the key is unchanged after finalise. Finalise checks size once
  (`recordings/service.ts:152-158`); later `process-audio.ts`, `preview-audio.ts`, `transcribe.ts`
  only `head()` for existence; `audio/ffmpeg.ts:316-323` streams the whole object to `tmpdir()` with
  no cap and `:379` reads the full rendition into memory.
- Attack (admin or stolen admin session): upload a 1 MB file, finalise, re-PUT a multi-GB file to the
  same key within the hour, trigger reprocess → worker disk/memory exhaustion and hours of ASR billing.
- Fix: sign `Content-Length` (or a `content-length-range` POST policy), re-check `head().size` in the
  worker before downloading, pin the finalised object's ETag in the row and compare.

### 10. Crash loop: boot sweep re-queues running jobs with no attempt cap
- `packages/db/src/jobs.ts:206-228` (`sweepRunning`) fails and **unconditionally re-enqueues** every
  `running` job; `worker/src/index.ts:38-50` runs it at every boot; pm2 restarts the worker after
  5 s. There is no `attempt` ceiling anywhere.
- A job that kills the process (OOM from finding 9, an uncaught rejection) runs again on every
  restart forever, re-paying any provider call made before the crash.
- Fix: carry `attempt` through the requeue and leave the job `failed` past N attempts, with a loud log.

### 11. Note drafts and offline identity survive sign-out on a shared device
- `packages/web/src/client/notes/draft.ts:11-13` keys drafts by recording only
  (`thp:note-draft:<recordingId>`); `note-composer.tsx:160,179` reads/writes them;
  `offline/manager.ts:333-339` also writes the text of a *refused* offline note (possibly private)
  into that draft; `sign-out-button.tsx:15-25` never clears `localStorage`.
- `offline/offline-api.ts:360-363` stores the full session payload (id, email, name, role) in
  IndexedDB under `meta.session:<userId>`; `manager.ts:204-229` stores other members' public notes;
  nothing is cleared on sign-out (`schema.ts:29-31` records this as a decision).
- Attack: A types a private note on a family device and signs out; B signs in and finds A's text
  pre-filled, and A's email and cached notes in IndexedDB.
- Fix: include the account id in the draft key and clear `thp:note-draft:*` on sign-out; delete
  `meta.activeUser` and `meta.session:*` on sign-out; drop `email` from the stored session copy.

---

## Low

### 12. Push subscriptions: endpoint takeover and limited SSRF
- `packages/db/src/schema.ts:1629` makes `push_subscription.endpoint` unique; `push.ts:153-160` upserts
  with `set: { userId: input.userId, ... }`, so whoever registers an endpoint last owns it.
- `notifications/push-service.ts:142-154` accepts any `https://` URL as a web endpoint;
  `push/src/web-push.ts:13-25` POSTs to it with the VAPID JWT, 16 in parallel (`dispatch.ts`); a
  404/410 deletes the row. `apns.ts:72` interpolates the token unescaped into the `:path`.
- Fix: on conflict only update when `user_id = excluded.user_id`; allow-list push-service origins
  (`fcm.googleapis.com`, `*.push.apple.com`, `*.notify.windows.com`, `*.push.services.mozilla.com`);
  refuse non-public IPs; URL-encode the APNs token.

### 13. Token-completion routes are not rate limited
- Guards exist on `POST sign-up`, `POST session`, `POST password-reset`, `POST account-deletion`. None
  on `GET password-reset?token`, `GET account-deletion?token`, `GET/POST invitations/accept`,
  `POST password-reset/complete`, `POST account-deletion/complete`
  (`packages/web/src/app/api/v1/auth/*/complete/route.ts`).
- Tokens are 256-bit so guessing is infeasible, but `account-deletion/complete` verifies the
  current password after the token (`account-deletion/service.ts`) with no limiter: anyone holding a
  live deletion link has an unbounded argon2 password oracle for that account for an hour.
- Fix: put the per-IP guard in front of the three completion routes.

### 14. Non-UUID ids reach Postgres and answer 500
- `server/api/params.ts` `routeParam` checks only non-empty; most services pass the id to
  `eq(uuidColumn, id)`; Postgres raises `22P02`, which is not an `ApiError`, so `route.ts` reports it
  to PostHog and answers 500. `POST /sync` (`offline/service.ts:267`) fails the whole batch the same
  way. Any member can generate error-tracker noise at will.
- Fix: validate UUID shape in `routeParam`/`parseEntry`; map `22P02` to `invalid_input`.

### 15. Deleting a member erases blocks others held against them
- `schema.ts:1867-1870` cascades `member_block` on `blocked_id`; `account-deletion.ts:110,119`
  reassigns public notes to a placeholder then deletes the user, so readers who had blocked the
  author now see those notes as "Removed member".
- Fix: re-point `blocked_id` to the placeholder before deleting.

### 16. `PATCH /users/:id` partial write
- `accounts/service.ts:729-752` writes `displayName` before authorising `role.assign`; a member sending
  both gets the name changed and a 403. Fix: authorise both halves first.

### 17. Database connection hardening
- `packages/db/src/client.ts:29-33` sets only `max`, `connect_timeout`, `onnotice`: no `ssl`, no
  `statement_timeout`, no `idle_in_transaction_session_timeout`. Localhost in production so TLS
  matters little, but a slow search (`search.ts`: HNSW + `ts_headline` over `perArm` rows) holds a
  pool slot indefinitely. Fix: set the timeouts via `connection: {...}`; require `sslmode` when the
  host is not loopback.

### 18. SMTP opportunistic TLS
- `server/mail/env.ts:40-50` sets `secure: port === 465` and nothing else; on 587/25 nodemailer falls
  back to plaintext if STARTTLS is absent, exposing `MAIL_PASSWORD`. Fix: `requireTLS: true`.

### 19. Member emails in logs
- `route.ts` `refuse`, `authorise.ts`, most `logger.info` audit lines write `actorEmail`; the logger
  (`shared/observability/logger.ts`) prints JSON to stdout → pm2 log files on the box. Not shipped to
  Grafana (Alloy ships metrics only), but the logs hold PII with pm2-logrotate retention. Fix: log
  `actorId` only, or hash the email as the limiter already does.

### 20. Undocumented open firewall port
- `scripts/verify-production.ts:472` accepts `7856` as an allowed ufw port; README "First setup"
  opens only 22, 80, 443 and nothing in the repo names 7856. Either document what listens there or
  remove it from the allow list so the check catches it.

### 21. Service-worker page cache purged only on explicit sign-out
- `public/sw/offline.js:107,191-199` drops `thp-pages-v1` only when `DELETE /api/v1/auth/session`
  passes through; the `thp:purge-pages` message is never sent. Session expiry, admin deactivation or
  a different member signing in leaves A's rendered member pages servable offline. Fix: also purge on
  successful `POST /auth/session` and `POST /auth/sign-up`.

### 22. Deploy pipeline hardening
- `.github/workflows/deploy.yml`: `skip_ci_gate` lets an approver ship an unverified commit (logged,
  by design); actions are version-tag pinned (`actions/checkout@v5`) rather than SHA pinned; the box
  deploys any `vX.Y.Z` tag it is handed (`scripts/deploy.sh`) so GitHub tag protection on `v*`
  should be enabled; `scripts/upload-sourcemaps.sh` does `set -a; source .env`, which executes `.env`
  as shell (a value containing `$(...)` runs). Tokens for reset/invite/deletion travel in query
  strings and therefore land in nginx access logs; consider `access_log` exclusion for those paths.

### 23. Model-generated chapter text is unbounded and unreviewed
- `minimax.ts:350-360`, `chapters/boundaries.ts:41-45`, `generate-chapters.ts:69-76` write titles and
  summaries straight from the model (by design, not via the review gate) with no length cap. A
  prompt-injected transcript can push long or misleading chapter text to members immediately. Fix:
  clip to the same limits the admin edit path enforces.

### 24. Development-only dependency advisories
- `vitest`/`@vitest/mocker` (code injection via mock registration), `vite` (launch-editor command
  execution on Windows, cross-origin script execution), `esbuild` via `drizzle-kit` (dev server
  request forgery), `@capacitor/cli` via `xcode`/`uuid`. None ship to production; upgrade on the next
  maintenance pass (`drizzle-kit` fix is a major).

---

## Info

### 25. Private notes are embedded through OpenAI
- `worker/src/embed-recording.ts:206-208` sends private note text to `api.openai.com`. Not a code
  bug; confirm the privacy notice and processor agreement cover it.

### 26. `.well-known` placeholders
- `apple-app-site-association` has `APPLE_TEAM_ID_PLACEHOLDER`; `assetlinks.json` lists
  `ANDROID_SIGNING_CERT_SHA256_PLACEHOLDER` next to a real fingerprint. Inert, but universal links
  will not verify until replaced.

### 27. Development compose
- `docker-compose.yml` binds `5432`, `9000`, `9001` on all interfaces with `thp/thp` and a fixed
  MinIO root password. Fine for a laptop, dangerous on any shared network; bind to `127.0.0.1:`.

### 28. Backup repository unencrypted
- `deploy/pgbackrest/pgbackrest.conf` `repo1-cipher-type=none`, documented as a decision. R2 encrypts
  at rest server-side; the R2 token in the config file is the only secret protecting the data.

---

## Verified sound (no finding)

- **API gate.** Every `/api/v1` route goes through `apiRoute(access, …)` (`server/api/route.ts`);
  public routes are an enumerated allowlist (11 entries) checked at request time; the policy table
  (`server/auth/policy.ts`) denies by default, is exhaustive over roles, and owned actions compare
  `ownerId` inside `can`. All admin-only operations use `permits(...)` with admin-only rules; every
  `SESSION` route is keyed on the caller or calls `authorise()` in-service. No handler spreads request
  JSON into a write; `role` is accepted only on `PATCH /users/:id` behind `role.assign` with a
  last-admin guard. The route sweep guard test asserts anonymous refusal for every discovered route.
- **Sessions and tokens.** 32 random bytes, stored as SHA-256 only, HttpOnly, `Secure` outside
  development, `SameSite=Lax`, server-side revocation on sign-out, deactivation and deletion; the
  actor is re-read from the DB on every request; password reset is single-use, atomic (`for update`),
  revokes all sessions; invitations claimed atomically. Argon2id 64 MiB / t=3 with a decoy verify for
  unknown addresses; sign-in and reset answer uniformly. Sign-in limited per address and per account
  (hashed); sign-up, reset, deletion limited per address and route-wide; client address trusts
  `X-Real-IP` first and the *last* `X-Forwarded-For` hop, matching `deploy/nginx/thp.conf`.
- **SQL.** Every `sql\`` binds parameters; `sql.raw` only on compile-time constants; vector
  literals built from `number[]`; no identifier or sort column from a caller. Email uniqueness is
  case-insensitive; tokens have unique indexes; `deleted ⇒ deactivated` and note-privacy checks exist.
- **Visibility.** Member reads of recordings, transcripts, chapters, scripture, playback, download,
  notes, progress, highlights and flow sessions all go through `findVisibleRecording(..., {
  includeUnpublished: false })`; series via `findVisibleSeries`; blocks applied on notes, replies,
  reactions, SOS, highlights and notifications; surface parameters can only narrow.
- **XSS.** Zero `dangerouslySetInnerHTML`/`innerHTML`/`eval`; no markdown renderer; all user and
  model text rendered as React text; `href`s from constants or server-built paths; push `href`
  validated path-only; no open redirect (no `next`/`redirect` param read anywhere).
- **Uploads.** Keys are server-minted UUIDs under fixed prefixes; PUTs bound to content type; no
  public ACL; finalise re-`head()`s size and type; note images enforce prefix and single use;
  playback GET requires a visible, published recording.
- **Worker.** ffmpeg via `spawn` argv (no shell) with integer-validated knobs and `mkdtemp` dirs
  cleaned in `finally`; provider endpoints hard-coded; Bible base URL env-only with a book allowlist;
  model output must arrive as a forced tool call, drafts go to the admin review queue, the model never
  chooses the recording or account written; no secrets logged.
- **Mail.** All HTML builders escape user fields; `from` env-only; feedback bounded (120/4000 chars)
  and forwarded only to the configured inbox.
- **Analytics.** First-party relay, session recording off, opt-out by default, identify with opaque
  id + role only, URL/referrer/IP stripped, reset on sign-out.
- **Infra.** nginx proxies on loopback with correct forwarded headers; cookies and Referer stripped
  from the analytics relay; README setup disables SSH passwords and root login, firewall 22/80/443,
  Postgres `listen_addresses='localhost'`; `.env` mode 600 and gitignored (asserted by
  `verify:production`); deploy key bound to a forced command that accepts only a release tag; deploy
  refuses dirty trees and non-tag checkouts; source maps uploaded then deleted from disk (or deleted
  when no CLI credentials); no secrets in the tracked tree or history; backups isolated from the
  media credential by a check; single-instance pm2 fork mode keeps the in-memory limiters correct.

## Suggested order of work

1. Upgrade `next` (+ `sharp`) and `nodemailer` (finding 1, 5).
2. Decide the registration model and close open sign-up (finding 2).
3. Tighten `deploy/sudoers/thp` argument lists (finding 3).
4. Fix avatar/artwork key binding (finding 4) and the search block predicate (finding 7).
5. Add security headers in nginx (finding 6).
6. Spend-on-failure ledger, attempt cap, upload size pinning (findings 8, 9, 10).
7. Sign-out hygiene in localStorage/IndexedDB/service worker (findings 11, 21).
8. The remaining Lows as a hardening pass.

---

## Resolution (29 October 2026, branch `security`)

| # | Status | What changed |
|---|--------|--------------|
| 1 | Fixed | `next` 16.3.1 → 16.4.3 (pulls `sharp` 0.35.5); `images.unoptimized` so `/_next/image` is not served. |
| 2 | Elsewhere | Public registration is being removed in a separate branch; nothing here. |
| 3 | Fixed | `deploy/sudoers/thp` pins every argument; the drill's postgres steps live in a root-installed `deploy/bin/thp-restore-drill-pg`; no bare `psql`/`pg_ctl`/`tee`/`touch` remain. |
| 4 | Fixed | Avatar and artwork keys must carry their prefix; `setAvatar` refuses a key another account holds; unique indexes on `user.avatar_key` and `series.artwork_key` (migration to be generated before merge). |
| 5 | Fixed | `nodemailer` 7.0.13 → 10.3.1. |
| 6 | Fixed | Nonce CSP from `packages/web/src/proxy.ts`; nosniff, `X-Frame-Options`, Referrer-Policy and Permissions-Policy from `next.config.ts`; HSTS, `server_tokens off` and token-path log exclusion in nginx. |
| 7 | Fixed | `embeddingVisibleTo` applies `noBlockBetween` through the note row for `note` embeddings. |
| 8 | Fixed | Paid steps throw a failure carrying their spend; `failJob` persists it; the ceiling sums succeeded and failed rows. |
| 9 | Partly | Worker re-checks the object's size against the upload ceiling before every download (the row stores no finalised size) and cuts a stream that overruns it. Signing `Content-Length` on the presigned PUT and pinning the ETag are not done: both change the upload client. |
| 10 | Fixed | The boot sweep leaves a job `failed` after three attempts and logs at error; an admin re-run is a fresh enqueue. |
| 11 | Fixed | Drafts keyed per account and cleared on sign-out; the IndexedDB session copy drops `email` and is deleted on sign-out; downloads stay. |
| 12 | Fixed, one deviation | Web endpoints must be on a known push-service host; store tokens are shape-checked; the APNs path is encoded. Re-pointing an endpoint to the account that presents it **stays allowed** (a shared phone whose previous session expired needs it) and is now logged at `warn` with the previous owner. |
| 13 | Fixed | A per-caller budget (`TOKEN_RATE_LIMIT_*`) in front of the reset, deletion and invitation previews and completions. |
| 14 | Fixed | `22P02` answers `invalid_input`; sync entries require a uuid recording id. |
| 15 | Fixed | Blocks held against a deleted member move to the placeholder. |
| 16 | Fixed | Both halves of `PATCH /users/:id` are authorised before either write. |
| 17 | Fixed | `statement_timeout` 30 s and `idle_in_transaction_session_timeout` 10 s on the pool (migrations unbounded); `ssl: 'require'` when the host is not loopback. |
| 18 | Fixed | `requireTLS` on every non-465 port. |
| 19 | Fixed | `actorEmail` removed from every log line; tests assert its absence. |
| 20 | Open | Port 7856 left in the allow list until the operator says what listens there. |
| 21 | Fixed | The page cache is also purged on a successful sign-in or sign-up. |
| 22 | Fixed | Actions SHA-pinned; `upload-sourcemaps.sh` parses `.env` instead of sourcing it; nginx skips access logs for token URLs; README notes tag protection. `skip_ci_gate` stays, by design. |
| 23 | Fixed | Chapter titles and summaries are clipped to the admin edit limits. |
| 24 | Fixed | `vitest` 4.1.12, `@capacitor/cli` 8.6.0. `drizzle-kit` left: the only fix is a downgrade. |
| 25–26, 28 | Noted | No code change. |
| 27 | Fixed | Compose binds Postgres and MinIO to `127.0.0.1`. |
