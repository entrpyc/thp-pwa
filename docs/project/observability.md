# Teaching Hub — Observability & analytics

The plan for knowing two things about the product: **is it up** (observability) and **is it doing
its job** (analytics). It stands beside `docs/project/prd.md` and `docs/project/tdd.md` and refines
project tdd 6.6, which promised structured logs, error tracking with alerting and a pipeline view
without saying what tooling delivers them or what is measured.

Two constraints shape everything below. **It costs nothing.** Every tool is on a free tier that
stops rather than bills when its allowance is spent, and section 4 shows how far those allowances
stretch. **Private content stays private** (project prd 6.7). Analytics sees that a note was
written, never what it said; section 5.4 is the list of what can never leave the product, and a
guard test holds it.

The first draft of this plan (10 September 2026) leaned towards observability: sixteen alerts,
OpenTelemetry in both processes, traces, shipped logs. It was reworked on **21 October 2026** in the
other direction. Alerting is now the minimum that says *the thing is down*, and the weight is on
analytics — specifically on the ten questions in the scope table. The decisions that cut the first
draft are recorded in section 2.5 so they are not re-litigated by accident.

Scope, settled with the operator on 21 October 2026:

| Area | Decision |
| :--- | :--- |
| **Alerting** | Only: the site is unreachable, a process is down, the worker is wedged, the host is running out of something, Postgres is in trouble, a backup did not happen. Seven alerts. Nothing about latency, error rates, providers, the pipeline or log volume. |
| **Streams** | How many times each recording was played. |
| **Listeners** | How many distinct members played each recording at least once. |
| **Returns** | How many times each member came back to a recording — one return per unique play. |
| **Completions** | How many distinct members listened to at least 80% of each recording. |
| **Tabs** | How often the chapters tab and the scripture tab are opened. |
| **Private notes** | How many are written, never what they say. |
| **Chapter jumps, speed changes** | Counted. |
| **Notifications** | How many are opened, per kind. |
| **Page visits** | Which member pages are visited, how often. |
| API latency, error rates, traces, log shipping | **Out of scope** (section 2.5). |
| Client errors, Web Vitals | **Out of scope** (section 9). |
| Studio efficiency for admins, acquisition and retention funnels | **Out of scope.** |

## 1. What exists already, and is kept

None of the following is rebuilt. The plan attaches to it.

- **Structured logs with a correlation id.** `packages/shared/src/observability/logger.ts` writes
  one JSON line per event to stdout, stamped with the id `correlation.ts` carries through the
  request and into the worker (project prd 6.12). pm2 captures stdout to files under `~/.pm2/logs`.
  That is where logs stay; nothing ships them anywhere.
- **A health check that is a real database round-trip**, readable without a session, at
  `GET /api/v1/health` (project prd 6.13). It always answers `200` and puts the verdict in `status`.
- **The playback progress row** in `packages/db/src/playback.ts`, one per member per recording,
  written at most every ten seconds while listening (project prd 3.2.5). Section 5.3 adds two
  columns to it and nothing else.
- **The job ledger** in `packages/db/src/jobs.ts` and **the spend ledger** in
  `packages/db/src/spend.ts`. They are the pipeline's own dashboard at `/admin/pipeline`, and this
  plan leaves pipeline health there rather than alerting on it.
- **`npm run verify:production`**, which reads the box and prints one PASS/FAIL line per check.
  Section 6.6 adds checks to it rather than inventing a second runbook.

## 2. Tooling

Four hosted services, all free, and one agent on the box. The application itself links to exactly
one of them — PostHog — through two adapter files, which is the same one-file-per-provider rule
every provider in this codebase already obeys. The other three never see application code.

- **2.1 PostHog Cloud, EU region — every analytics question.** One SDK on the client
  (`posthog-js`) for member actions and page views, and one on the server (`posthog-node`) for the
  single event that must be computed server-side, completion. Hosted in AWS eu-central-1
  (Frankfurt); the region is chosen at sign-up and cannot be changed afterwards. **Expensive to
  reverse** in the sense that a year of event history lives there; the adapter makes the code side
  cheap.

- **2.2 Grafana Cloud Free with Grafana Alloy on the host — host, Postgres and process health.**
  Alloy is installed as a systemd service on the VPS and does three things: scrapes the host (node
  exporter, built in), scrapes Postgres (postgres exporter, built in), and watches for the two pm2
  processes by name (process exporter, built in). It forwards the metrics to Grafana Cloud, which
  holds one dashboard and five alert rules. It is off the box — which matters, because monitoring
  that lives on the machine goes blind exactly when the machine dies. **It receives nothing from
  the application.** No OTLP receiver, no log tailing.

- **2.3 UptimeRobot Free — is the site up, asked from outside.** Two monitors: the health route,
  checked for the string `"status":"ok"`, and the sign-in page. Five-minute interval, e-mail alerts.
  Kept separate from Grafana because an alert about Grafana being unreachable should not come from
  Grafana.

- **2.4 Healthchecks.io Free — dead-man's switches for things that must happen on a schedule.**
  A check is a URL the job pings when it finishes; the service alerts when the ping does not arrive.
  Four checks: the nightly backup, the daily archive check, the restore drill receipt, and the
  worker's poll loop. README.md "Backups" already says the one failure nobody notices is the timer
  that never fires; this is what notices it.

- **2.5 Removed from the first draft, and why.** These are decisions, not oversights.

  | Removed | Why |
  | :--- | :--- |
  | OpenTelemetry SDK in the API and worker (traces, per-route latency and error histograms) | The heaviest maintenance item in the plan: the OTel JS packages, the `pg` and `undici` instrumentations and the Next.js instrumentation hook all move fast and break across minor versions. None of the seven alerts needs it. If a slow request ever needs explaining, the correlation id in the pm2 logs is still there. |
  | Log shipping to Loki | Cheap and app-code-free, but it existed to feed alerts on error-line volume and to pair with traces. With neither, the pm2 files on the box are enough. |
  | Eight alerts: API 5xx, API p95, rate-limit probing, pipeline age, pipeline failure, spend ceiling, provider error rate, error-log volume | Each one is a threshold that needs tuning and an e-mail that needs reading. The pipeline and the spend ceiling already have a screen (`/admin/pipeline`); the rest were observability for its own sake at this product's size. |
  | ~~New exception issue~~ | Removed here on 21 October 2026 with the eight above, and **brought back on 24 October 2026** as A8 (section 5.6, section 7). It is the one of the nine that is not a threshold: a *new* issue is a failure the software has never had before, and that is an e-mail worth reading once. |
  | Client error tracking and Web Vitals in PostHog | Not on the list of questions. Both were one flag away in the SDK; **both turned on 24 October 2026** — error tracking with the server-side reports (section 5.6), Web Vitals when the operator enabled them in the project (section 5.7). |
  | Playback delivery events (first audio, stall, error, grant renewal, seek) | Observability of the player, not a question about members. Deferred to section 9. |
  | Sentry, Grafana Faro, self-hosted Prometheus/Loki/Grafana, self-hosted PostHog, Umami/Plausible/Matomo | Same reasons as the first draft: user limits, RAM on an 8 GB box, ClickHouse, or no typed events. The self-hosted Grafana stack remains the fallback if Grafana Cloud's free tier goes away; Alloy points at a different address and nothing else changes. |

## 3. Free tiers, verified

Every number below was read from the vendor's public pricing page on **10 September 2026**. Free
tiers change; the operator checklist (section 8) says to re-read this table at each sign-up and to
correct it here if a number has moved.

| Service | Allowance per month | Retention | Users | When the allowance is spent |
| :--- | :--- | :--- | :--- | :--- |
| PostHog Cloud (US or EU) | 1,000,000 events · 100,000 exceptions · 5,000 session replays · 1,000,000 feature-flag requests · 1,500 survey responses · 1 project | 1 year | Unlimited | Ingestion stops until the month resets. No card is required, so nothing can be billed. |
| Grafana Cloud Free | 10,000 active metric series · 50 GB logs · 50 GB traces · 50 GB profiles · 100k synthetic API checks · 500 k6 virtual-user hours · 50k frontend sessions | 14 days | 3 active | Ingestion is rate-limited or refused past the cap. No card is required. |
| UptimeRobot Free | 50 monitors at a 5-minute interval · 1 status page · 5 integrations · e-mail alerts (SMS and voice are paid credits) | 3 months | 1 | Hard cap on monitors. |
| Healthchecks.io Hobbyist | 20 checks · 100 log entries per check · e-mail and the common chat integrations | — | — | Hard cap on checks. |

The one number this plan is designed around is PostHog's **1,000,000 events**. Grafana's 10,000
series is not close to being spent by host and Postgres metrics alone (section 4.3).

## 4. Budget: what free supports

### 4.1 A listening session

The unit everything is costed in. A member opens the app, browses, plays part of a teaching,
perhaps opens a tab or writes a note, and leaves. Project tdd 8 assumes ~4 hours of listening per
member per month; this plan assumes a heavier **3 sessions per member per week**, so the estimate is
conservative.

What one session sends, with autocapture **off** and session replay **off**:

| Source | Events | Notes |
| :--- | ---: | :--- |
| Page views | 6 | Library, series, recording, now-playing, notifications, back. One `$pageview` each. |
| Plays | 1 | One `playback_started` per unique play (section 5.2). Pausing and resuming adds none. |
| Completion | ½ | Server-side, at most once per member per recording, ever. |
| Tabs | 2 | Chapters, scripture, notes or transcript opened. |
| Chapter jumps | 1 | |
| Speed change | ⅓ | Most members set it once and leave it. |
| Notes | ⅓ | Most sessions write none. |
| Notification opened | ½ | |
| **Total** | **~12** | **Budgeted as 15** to leave room for events not yet designed. |

### 4.2 Sessions per week, free

| Tool and limit | Per session | Sessions/month free | **Sessions/week free** |
| :--- | ---: | ---: | ---: |
| PostHog — 1,000,000 events | 15 events | 66,600 | **15,400** |
| Grafana metrics — 10,000 series | independent of sessions | — | see 4.3 |

Against the product's own numbers:

| Members | Sessions/week at 3 per member | PostHog events/month | Share of the free tier |
| ---: | ---: | ---: | ---: |
| 100 (launch) | 300 | ~19,500 | 2% |
| 1,000 (target) | 3,000 | ~195,000 | 20% |
| 2,500 | 7,500 | ~490,000 | 49% |
| 5,000 | 15,000 | ~975,000 | 98% |

The free tier carries the product to five times its target membership. If it is ever approached,
the lever is `$pageview`, which is half the budget and the least valuable half; sampling it to one
in two buys another 2,000 members.

### 4.3 Metric series

Series are counted per unique label combination. Nothing here labels a metric by user, recording
or job, because nothing here comes from the application.

| Producer | Estimate | Basis |
| :--- | ---: | :--- |
| Node exporter (host) | ~1,000 | Default collectors on one host |
| Postgres exporter | ~500 | One database, default collectors |
| Process exporter | ~50 | Two named process groups |
| Alloy's own metrics | ~200 | |
| **Total** | **~1,750** | 18% of 10,000 |

### 4.4 What it costs the host

Alloy runs at roughly 100 MB resident with the three exporters. The application gains one small
client script and one server-side SDK that sends one event per completion. No new database, no new
container, no new port open to the internet, and no listener on the box: Alloy only pushes outward.

## 5. What is tracked

### 5.1 Observability signals (Grafana Cloud, UptimeRobot, Healthchecks.io)

| Area | Signal | Source | Alert |
| :--- | :--- | :--- | :--- |
| Uptime | Health route answering `ok`; sign-in page reachable | UptimeRobot from outside | Two consecutive failures |
| Processes | `thp-web` and `thp-worker` present, as seen by the process exporter matching the pm2 script paths | Alloy process exporter | Either absent for 2 min |
| Worker | Poll loop alive | Healthchecks.io ping every 5 min from the loop | Missed by 10 min |
| Host | CPU (including steal), memory, disk, inode, load, network | Node exporter | Disk above 85%; memory above 90% for 10 min; steal above 20% for 15 min |
| Postgres | Connections, transactions, cache hit ratio, dead tuples, longest transaction | Postgres exporter | Connections above 80% of `max_connections`; a transaction open longer than 5 min |
| Backups | Nightly backup, daily archive check, restore drill | Healthchecks.io pings from the systemd units | Missed by 1 h; drill receipt older than 90 days |

One Grafana dashboard, *Host and Postgres*, shows all of the Alloy-sourced rows. Every alert goes
to one contact point: e-mail to the operator. Chat integrations are added later if wanted; the free
tiers all include them.

### 5.2 Product events (PostHog)

The vocabulary is a typed union in `packages/shared/src/observability/analytics.ts`, so the set of
events and their properties is one file and a build fails on an untyped property. Names are
`snake_case` nouns and past-tense verbs.

**Identity.** `distinct_id` is the account's opaque id — the same UUID the API already uses, never
the e-mail. One person property: `role`. Identification happens at sign-in and is reset at
sign-out.

**Common properties on every event.** `app_version` (the release tag) and `install_source`
(`browser`, `pwa`, `ios_store`, `android_store`).

**Definitions that the numbers depend on.**

- **A unique play** is the first time audio starts after a recording is loaded into the player.
  Pausing and resuming the same loaded recording is the same play. Navigating away and coming back,
  or opening the app again later, loads it afresh and is a new play. So a member who opens the app
  three times in one day on the same recording has three plays — a play measures a *visit*, not a
  day. Streams, listeners and returns are all read from this one event (section 5.4).
- **A completion** is a member having *listened* to at least 80% of a recording's duration,
  accumulated across every visit, with seeking excluded. It is computed on the server from the
  progress row (section 5.3) and fires at most once per member per recording, ever. It cannot be
  earned by scrubbing to the end, and listening at 2× counts fully because media time is what is
  measured, not wall time. This is a sharper reading of project prd 3.2.8 ("once they reach the
  end"), and the PRD is amended to say 80% when 3.2.8 is implemented.

| Question | Event | Properties | Fires when |
| :--- | :--- | :--- | :--- |
| Streams, listeners, returns | `playback_started` | `recording_id`, `series_id`, `resumed` (position above zero), `speed` | A unique play, as defined above. In `player-context.tsx`, where a flag reset on load is cleared by the first `play`. |
| Completions | `playback_completed` | `recording_id`, `series_id` | **Server-side**, the moment the progress write crosses 80% (section 5.3). |
| Tabs | `tab_opened` | `tab` (`chapters`, `scripture`, `notes`, `transcript`, `mindmap`), `surface` (`recording`, `chapter`), `recording_id` | A tab is opened. The recording page's `chooseTab` and the chapter page's toggle are the two call sites; closing a tab fires nothing. Chapters and scripture are the two asked for; the others cost nothing extra — `mindmap` arrived with prd 3.8.3 and rides the same call. |
| Private notes | `note_created` | `recording_id`, `visibility` (`public`, `private`), `is_reply` | The note form's submit succeeds. Public notes and replies ride along for free. |
| Chapter jumps | `chapter_jumped` | `recording_id`, `chapter_index` | The chapters panel's `playFromMs` is called from a chapter row. |
| Speed changes | `speed_changed` | `speed` | `chooseSpeed` accepts a new rate. |
| Notifications | `notification_opened` | `kind` (the shared tuple), `channel` (`in_app`) | A row in the notifications centre is tapped. Opens from an OS push notification do not pass through the centre and are not counted (section 9). |
| Page visits | `$pageview` | `route` (the pattern, never the URL), `recording_id` or `series_id` where the route has one | Member-area navigation, from the provider's router hook. Admin pages send nothing. |

The `route` patterns are the member-area page files as they stand: `/`, `/recordings`,
`/recordings/[id]`, `/recordings/[id]/chapters/[chapterId]`, `/series`, `/series/[id]`,
`/now-playing`, `/notifications`, `/profile`, `/feedback`. A page view carries the id as a property
so "how often is the recording page visited" and "how often is *this* recording's page visited" are
both one breakdown.

### 5.3 Completion, in the database

Completion is the one metric that cannot be computed on the client, because a member who listens to
50% today and 40% tomorrow has completed the recording and no single visit sees that. So the
progress row learns two things it does not know today.

| Column on `playback_progress` | Meaning |
| :--- | :--- |
| `listened_ms` | Media time actually heard, accumulated across visits. `0` by default. |
| `duration_ms` | The recording's length as the client's element last reported it, because nothing else in the schema knows it (the schema deliberately has no `duration` on `recording`). |
| `completed_at` | Set once, when `listened_ms` first reaches 80% of `duration_ms`. Never cleared. The column project prd 3.2.8 needs, and the seam for showing completed teachings when browsing. |

**Client.** The player already handles `timeupdate` to drive its progress timer. It additionally
accumulates `listenedMs += delta` for every tick where the element is playing and the delta since
the last tick is between zero and two seconds; a larger jump is a seek or a return from the
background and is not listening. The accumulator is reset when a recording is loaded. Nothing is
*sent* on `timeupdate`; the existing throttled progress `PUT` (at most every ten seconds, and on
pause, hide and navigation) gains two fields: `listenedMs`, the delta since the last successful
write, and `durationMs`. A dropped write loses its delta, which biases completion downward and is
accepted, the same way a dropped position is accepted today.

**Server.** `writePlaybackProgress` becomes one `UPDATE … RETURNING` that adds the delta to
`listened_ms`, stores `duration_ms`, and sets `completed_at = now()` where it is null and the new
total is at or above 80% of the duration. The row coming back says whether `completed_at` was set
by *this* write; if so, and only then, the server adapter sends `playback_completed`. One statement,
so two concurrent writes cannot both claim the transition.

**What this touches that is not analytics.** The migration test in
`packages/db/tests/integration/migrations.test.ts` asserts the exact column set and is updated; the
schema comment on `playbackProgress` that explains why `completed_at` was absent is rewritten to
explain why it is present; the five-second rule in `cadence.ts` (a position under five seconds is
not stored) is unchanged, so listening to the first four seconds accumulates nothing — which is
correct.

### 5.4 Where the questions are answered

Saved PostHog insights, created once and listed here so that a new operator knows what exists.
All on one dashboard, *Teaching Hub*.

1. **Streams per recording** — total `playback_started`, broken down by `recording_id`; the same
   by `series_id`.
2. **Listeners per recording** — unique users on `playback_started`, same breakdowns.
3. **Returns per recording** — a formula insight, streams ÷ listeners, which is the average number
   of times a listener came back. The distribution ("how many members returned once, twice, three
   or more times") is the one number that is not a click-together chart; it is this saved HogQL
   query:

   ```sql
   select plays, count() as members from (
     select distinct_id, count() as plays
     from events
     where event = 'playback_started' and properties.recording_id = {recording}
     group by distinct_id
   ) group by plays order by plays
   ```

4. **Completions per recording** — unique users on `playback_completed`; completion rate as a
   formula, completions ÷ listeners.
5. **Tabs** — `tab_opened` by `tab`, over time and per recording.
6. **Notes** — `note_created` by `visibility`, over time and per recording.
7. **Chapter jumps and speed changes** — one trend each.
8. **Notifications opened** — `notification_opened` by `kind`.
9. **Page visits** — `$pageview` by `route`, and the recording page by `recording_id`.

**Cross-checks.** Two numbers must agree with the database or the instrumentation is wrong:
completions against `count(completed_at)` on `playback_progress`, and notes created against the
`note` table. Streams and listeners have no database counterpart because there is no play log
(project prd 3.2.7 is deferred); until there is, PostHog is the only record of them.

### 5.5 Privacy rules

Project prd 6.7 makes private content invisible to admins, and an analytics tool an admin can log
into is a second admin. So:

- **Never sent, in any property, under any name:** note text, search query text, questionnaire
  responses, Flow Tracker answers, mind-map content, display names, e-mail addresses, IP addresses,
  raw URLs containing more than a route pattern.
- **Allowed:** opaque ids, enums, counts, durations, booleans.
- **Held by a guard test.** `tests/guards/analytics-vocabulary.test.ts` walks the event union and
  refuses any property typed `string` that is not an id or an enum, and
  `tests/guards/analytics-boundary.test.ts` refuses `posthog-js` or `posthog-node` imported anywhere
  but their adapter files — the same shape as `asr-boundary.test.ts`.
- **PostHog project settings:** *Discard client IP data* on; autocapture off; session replay off;
  *Mask all text and inputs* on in case replay is ever enabled; `$pageview` sends the route pattern.
- **First-party path.** The browser sends events to `/relay/` on the app's own origin and nginx
  forwards them to the EU host (`deploy/nginx/thp.conf`), so a content blocker that drops
  `eu.i.posthog.com` by name drops nothing. nginx strips the session cookie and the Referer before
  forwarding and adds no `X-Forwarded-For`. The path is named once in the client
  (`ANALYTICS_PROXY_PATH`) and `tests/guards/analytics-proxy.test.ts` holds it equal to the nginx
  block. Store builds never needed this — content blockers do not reach a Capacitor web view — so
  the gain is browser and installed-web-app traffic.
- **Grafana** sees the host and the database, never the application. Metric labels carry no ids.
- **The privacy policy** the store listings need (project prd 5.2.3) names PostHog and Grafana Labs
  as processors, both in the EU.
- **The mock switch** (`THP_MOCK_EXTERNAL=true`) turns both PostHog adapters into no-ops, so no
  test run, development machine or CI job ever reaches PostHog. `tests/guards/mock-switch.test.ts`
  gains the two new adapters.

### 5.6 Exceptions (PostHog error tracking)

Added **24 October 2026**, revisiting two lines of section 2.5. An exception is not an analytics
event about a member; it is a fact about the software, and the question it answers is *has
something started failing that never failed before*. It is sent to the same PostHog project, under
the same key, through the same per-process adapters, and held to the same privacy rule.

**What is reported, and from where.**

| Process | When | Context sent | Adapter |
| :--- | :--- | :--- | :--- |
| API | The shared route wrapper's catch block — an error no handler handled, answered as a 500. An `ApiError` is a refusal, not a crash, and is never reported. | `correlation_id`, `method`, `route` (the **pattern**: every UUID, number or token segment is `[id]`), `status` | `packages/web/src/server/observability/analytics.ts` |
| Worker | A handler's throw in `runJob`, after the row is failed; and a ledger write the loop could not make. The runner's own refusals (no handler, the spend ceiling) are decisions and are not reported. | `correlation_id`, `job_id`, `step`, `attempt`, `recording_id` | `packages/worker/src/observability/exceptions.ts` |
| Client | `window` `error` and `unhandledrejection`, installed by the adapter when it starts. Under the member's analytics consent like every event: a member who turned analytics off sends no stack traces either. | none beyond the common properties | `packages/web/src/client/observability/analytics.ts` |

Each report carries the error's name, bounded message and stack — what a log line already has —
plus `process` (`api`, `worker`, `client`) and `app_version`, so an issue is placed on a release.
The server-side reports are filed under the process's own distinct id (`thp-api`, `thp-worker`)
with no person profile: **no member is identified by a server crash**, and the correlation id,
which is already on the response and in the pm2 logs, is what joins the issue to the request.

**Privacy.** The context above is the whole list, held by `exceptionProperties()` in
`packages/shared/src/observability/exceptions.ts`, which loops over the allowed names rather than
over its argument, and `tests/guards/analytics-vocabulary.test.ts` refuses a content word among
them. Never a request body, never a note's text, never a raw URL (`apiRoutePattern` on the server;
the SDK's URL stamps stripped on the client as for every event). Messages are cut at 500
characters so a provider's response echoed into one cannot carry a transcript. The mock switch and
the production-only rule silence all three adapters through one reader
(`readAnalyticsConfigNamed`, now in `@thp/shared`; `tests/guards/mock-switch.test.ts`).

**The alert** is A8 in section 7: PostHog's *new issue* alert on the project, to the operator's
e-mail. The other eight alerts cut in 2.5 stay cut; this one came back because it is the only one
that fires on something new rather than on a threshold.

**Budget.** The free tier allows 100,000 exceptions a month (section 3); a product this size
produces a handful. A client-side loop that throws on every frame is the one way to spend it, and
PostHog's per-issue rate limiting is what stops that costing the month.

### 5.7 Web Vitals

Turned on **24 October 2026**, when the operator enabled Web Vitals in the PostHog project. The
SDK sends one `$web_vitals` event per page load, batched after five seconds, with the four metrics
(LCP, CLS, FCP, INP) as `$web_vitals_<metric>_value` and the metric object as
`$web_vitals_<metric>_event`. It is an event like any other: under the member's consent, counted
against the event budget (one per page view, so section 4.2's room halves and still holds), sent
through `/relay/`.

Three things the adapter settles that the project setting alone does not:

- **The metric code is in the bundle.** The SDK fetches it from its CDN by default, which
  `disable_external_dependency_loading` refuses (§ 5.5); the adapter imports
  `posthog-js/dist/web-vitals` instead, and the SDK finds the callbacks already registered.
- **No attribution.** `web_vitals_attribution` is empty: attribution names the slow element and
  its resource URL, and for artwork a resource URL is a signed media grant.
- **The payload is sanitised.** Each nested metric object carries the page URL, the raw
  performance entries (an LCP entry names the element and the image URL) and the SDK's session
  stamps. `stripUrlProperties` removes the URL stamps, `entries` and `attribution` from every
  `$web_vitals_*_event`, leaving `name`, `value`, `rating`, `delta`, `id` and `navigationType` —
  numbers and enums, which is what § 5.5 allows. `packages/web/tests/unit/analytics.test.ts`
  holds it.

PostHog's built-in Web Vitals dashboard reads the `_value` properties and needs nothing else. If
a slow number ever needs diagnosing, attribution for one metric is one entry in that array, and
the sanitiser has to be widened deliberately for it — which is the point.

## 6. Implementation

Four phases, each shippable on its own. Phase 1 is operator work with no code change. The
application never gains a dependency on Grafana, Alloy, UptimeRobot or Healthchecks.io beyond one
outbound ping from the worker.

### 6.1 Files

| Path | Role |
| :--- | :--- |
| `packages/shared/src/observability/analytics.ts` | The typed event vocabulary and the `track()` signature. No SDK import. |
| `packages/web/src/client/observability/analytics.ts` | The **only** file that imports `posthog-js`. Initialises with the EU host, identifies, exposes `track()`. |
| `packages/web/src/client/observability/analytics-provider.tsx` | Mounts the SDK in the member layout, wires `$pageview` with the route pattern to the router. |
| `packages/web/src/server/observability/analytics.ts` | The only file in the API that imports `posthog-node`. Server-side `track()`, used by exactly one caller, and `captureServerException()`, used by exactly one: the route wrapper's catch block (section 5.6). |
| `packages/shared/src/observability/exceptions.ts` | The shape of an exception report — the allowed context, the route-pattern rule, the message bound. No SDK import. |
| `packages/shared/src/observability/analytics-config.ts` | The one reader of whether analytics is on, for all three processes. |
| `packages/worker/src/observability/exceptions.ts` | The only file in the worker that imports `posthog-node`. Reports a failed job; called from `runJob` and the loop. |
| `packages/db/src/schema.ts`, `packages/db/src/playback.ts`, one migration | The three columns and the `UPDATE … RETURNING` from section 5.3. |
| `packages/web/src/server/playback/state.ts` | `writePlaybackProgress` accepts the two new fields and sends `playback_completed` on the transition. |
| `packages/web/src/client/playback/cadence.ts` | Unchanged rule; the listened accumulator lives beside it. |
| `packages/web/src/app/(member)/player-context.tsx` | `playback_started` on the first play after load; `speed_changed`; the listened accumulator; the two new fields on the progress write. |
| `packages/web/src/app/(member)/recordings/[id]/recording-view.tsx` and `chapters/[chapterId]/chapter-view.tsx` | `tab_opened`. |
| `packages/web/src/app/(member)/recordings/[id]/chapters-panel.tsx`, `notes-panel.tsx`, `notifications/notifications-centre.tsx` | `chapter_jumped`, `note_created`, `notification_opened`. |
| `packages/worker/src/observability/heartbeat.ts` | The Healthchecks.io ping from the poll loop. |
| `deploy/observability/alloy.alloy` | Alloy's config: node, Postgres and process exporters, remote-write to Grafana Cloud. No receivers, no secrets. |
| `deploy/observability/alloy.default` | Template for `/etc/default/alloy`: the four values the config reads from its environment. |
| `deploy/observability/healthchecks.env.example` | Template for `/etc/thp/healthchecks.env`: the three ping URLs. |
| `deploy/observability/alerts.json` | The five Grafana alert rules, exported from the UI and committed so they survive a stack rebuild. |
| `deploy/observability/dashboards/host-and-postgres.json` | The one Grafana dashboard. |
| `deploy/systemd/thp-backup*.service` | Gain an `ExecStartPost` ping to Healthchecks.io. |
| `scripts/verify-production.ts` | New checks, section 6.6. |
| `.env.example` | New variables, section 6.7. |

### 6.2 Phase 1 — the box, no code

1. Alloy installed from Grafana's apt repository, running as its own user, config from
   `deploy/observability/alloy.alloy`, environment from `deploy/observability/alloy.default`.
2. A read-only `monitoring` role in Postgres with `pg_monitor`.
3. The host dashboard imported; the host, Postgres and process alerts created, from the PromQL in
   README.md "Monitoring".
4. UptimeRobot monitors and Healthchecks.io checks created; the backup systemd units and
   `scripts/restore-drill.sh` ping theirs through `/etc/thp/healthchecks.env`.
5. `verify:production` gains `alloy` and `backup-pings` (section 6.6).

The repository side of this phase — the Alloy config and its environment template, the ping lines
in the units and the drill, the two checks — is code, and reaches the box only through a release,
because `verify:production`'s `release` and `secrets` checks refuse anything else.

**Proof:** `verify:production` passes `alloy` and `backup-pings`; the host dashboard shows data;
stopping the worker for three minutes produces the process alert (A2) and starting it clears it.
(A3 needs the heartbeat from phase 3.)

### 6.3 Phase 2 — PostHog on the client

1. The vocabulary, the adapter, the provider in the member layout, identify at sign-in and reset at
   sign-out, `$pageview` with the route pattern and the id property.
2. `playback_started` in `player-context.tsx`: a `playedSinceLoad` ref, reset where a recording is
   loaded, cleared and tracked by the first `play`.
3. `tab_opened`, `note_created`, `chapter_jumped`, `speed_changed`, `notification_opened` at the
   call sites named in 6.1.
4. The guard tests from 5.5.

**As built (21 October 2026).** Four things the plan did not spell out and the code settled:

- The vocabulary is a **runtime table** the types are derived from, so the guard test can walk it
  and the adapter can sanitise against it: a property the table does not name, or a value that is
  not what its kind says, is dropped before the SDK sees it. A note's text cannot leave even
  through a mistaken call.
- The one person property, `role`, is built by the policy module (`analyticsPerson`) and passed
  through whole, because `tools/role-usage.ts` allows no other file to read an actor's role.
- The mock switch reaches the client as `NEXT_PUBLIC_THP_MOCK_EXTERNAL`, mirrored by
  `next.config.ts`, and `app_version` is `git describe` at build time. Neither is a variable the
  operator sets.
- The resume row carries the series id, so a play the transport reports on resume names the
  series the way a play from the recording page does.

**Proof:** the guard tests pass; a manual session shows every event in PostHog's live view with no
string property that is not an id or an enum; pausing and resuming sends no second
`playback_started`; navigating away and back does.

### 6.4 Phase 3 — completion, and the worker heartbeat

1. The migration: `listened_ms integer not null default 0`, `duration_ms integer`,
   `completed_at timestamptz`. The migration test's column set and the schema comment updated.
2. The client accumulator and the two new fields on the progress `PUT`, as section 5.3 describes;
   the server's single-statement update; the server adapter and its one call.
3. The worker heartbeat: a `fetch` of `HEALTHCHECK_WORKER_URL` at the top of each poll, at most once
   every five minutes, fire-and-forget. Absent URL means no ping, logged once at boot.

**As built (21 October 2026).**

- Migration `0027_playback_completion`. The old `upsertPlaybackProgress` stays, as a wrapper over
  `recordPlaybackProgress`, which takes the delta and the duration and answers whether *this*
  write completed the teaching: `completed_at` and `updated_at` are both `now()` in the statement
  that sets them, and `now()` is one value per statement, so equality is the signal.
- The client cadence file gains `listenedStep`, the pure rule for what a gap between two ticks is
  worth: a step up to two seconds while playing counts; a jump, a step backwards, a tick while
  paused counts nothing. Media time, so 2× counts in full.
- The server clamps a listened delta past an hour rather than refusing the write, and accepts a
  body with neither new field, so a client from before this release still lands its position.
- The `heartbeat` check in `verify:production` reads the worker's own log for its last
  `worker.heartbeat.sent` line rather than Healthchecks.io's status, which has no public read
  without an API key. It is therefore a box check, not a remote one.

**Proof:** listening to 80% of a short recording across two separate visits sets `completed_at`
exactly once and produces exactly one `playback_completed`; scrubbing to the end of an unlistened
recording produces none. Stopping the worker for ten minutes produces A3.

### 6.5 Phase 4 — dashboards, alerts and insights as files

The Grafana dashboard and alert rules created by hand in phase 1 are exported and committed under
`deploy/observability/`, and importing those files into a fresh Grafana stack reproduces the setup.
The nine PostHog insights cannot be exported as files; they are listed in 5.4 so a new operator can
recreate them, and the HogQL query is recorded there verbatim.

### 6.6 Verification

`verify:production` gains these checks, each one line of PASS/FAIL like the rest:

| Check | Passes when |
| :--- | :--- |
| `alloy` | The `alloy` systemd unit is active, its `/-/ready` endpoint on `127.0.0.1:12345` answers, and every component in `/api/v0/web/components` reports itself healthy — which is how a wrong Postgres password or a dead Grafana token shows up. |
| `backup-pings` | `/etc/thp/healthchecks.env` names an `https` URL for all three pings, and the *installed* `thp-backup` and `thp-backup-check` units carry the `ExecStartPost` that sends theirs. |
| `analytics` | The built client chunks under `packages/web/.next` carry a `phc_` key and the EU host — read from disk, because the adapter is in the member layout's chunk and an anonymous fetch of the origin is handed the sign-in page — and `POSTHOG_KEY` is set for the API. |
| `analytics-proxy` | An empty POST to `/relay/e/` on the origin is answered by PostHog's plain-text `400 request missing data payload` rather than by Next — which is what a live nginx block that was never given the `location /relay/` would do, silently losing every event. |
| `heartbeat` | `HEALTHCHECK_WORKER_URL` is set and the worker's pm2 log carries a `worker.heartbeat.sent` line in the last 10 min. |
| `not-mocked` | Already exists; unchanged — `THP_MOCK_EXTERNAL` is not `true` on the box. |

All four read the box; `--remote-only` covers none of them.

### 6.7 Configuration

Added to `.env.example`, with the same rule as every other block: a deployment sets them, a
development machine leaves `THP_MOCK_EXTERNAL=true` and none of them is read.

| Variable | Read by | Meaning |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_POSTHOG_KEY` | Client | The project's public key. Inlined at build time like `NEXT_PUBLIC_API_ORIGIN`, and subject to the same "build after `.env`" rule. |
| `NEXT_PUBLIC_POSTHOG_HOST` | Client | `https://eu.i.posthog.com` — the upstream nginx forwards `/relay/` to. The browser itself sends to `/relay/` on the app's origin (section 5.5). |
| `POSTHOG_KEY`, `POSTHOG_HOST` | API | The same key and host, for `posthog-node`. |
| `HEALTHCHECK_WORKER_URL` | Worker | The worker heartbeat's ping URL. Absent means no ping, logged once at boot. |

Grafana Cloud's endpoint, instance id and token, and the monitoring role's connection string, live
in `/etc/default/alloy` (root-owned, mode 600, from `deploy/observability/alloy.default`), which
Alloy's config reads through `sys.env()` so the committed config carries no secret. The three
Healthchecks.io URLs for the backup units and the restore drill live in `/etc/thp/healthchecks.env`
(root-owned, group `thp`, mode 640, from `deploy/observability/healthchecks.env.example`), read by
the units through `EnvironmentFile=` and by the drill script. Neither is ever in `.env`.

### 6.8 Failure posture

Analytics never blocks or fails anything (project prd 6.5, by analogy). Every SDK call is
fire-and-forget; the client SDK swallows its own errors; the server adapter's send is not awaited
inside the progress write, so a PostHog outage cannot slow a listener down. The one exception is
the guard tests, which fail a build, because a privacy violation is not a runtime condition.

The completion *column* is not analytics: it is written whether or not PostHog is reachable, and
the PRD feature that will read it depends on the column, never on the event.

## 7. Alerts, in one list

| # | Condition | Source | Why |
| :- | :--- | :--- | :--- |
| A1 | Health route not `ok`, twice in a row | UptimeRobot | The site is down or the database is unreachable. |
| A2 | `thp-web` or `thp-worker` absent for 2 min | Grafana | pm2 failed to bring it back. |
| A3 | Worker heartbeat missed by 10 min | Healthchecks.io | The loop is wedged even though the process is alive. |
| A4 | Disk above 85%, memory above 90% for 10 min, steal above 20% for 15 min | Grafana | The box is running out of something. |
| A5 | Postgres connections above 80%, or a transaction open longer than 5 min | Grafana | The database is about to refuse connections or is holding a lock. |
| A6 | Nightly backup or daily archive check missed by 1 h | Healthchecks.io | The one failure nobody notices. |
| A7 | Restore drill receipt older than 90 days | Healthchecks.io | An unverified backup is not a backup. |
| A8 | A **new** exception issue in the project | PostHog | Something is failing that never failed before — in the API, the worker or a member's browser (section 5.6). Fires once per new issue, never on volume. |

Eight. A8 is the one decision in section 2.5's table that moved the other way, on 24 October
2026; the list grows only that way.

## 8. Operator checklist

Everything the operator does by hand, in order. Estimated at one afternoon.

**Accounts** — pick the EU region wherever it is offered; it cannot be changed later.

1. Create a **Grafana Cloud** account and a stack in the EU region. Note the stack's Prometheus
   remote-write endpoint and instance id, and create an access-policy token with `metrics:write`.
2. Create a **PostHog Cloud EU** organisation and one project. In project settings: turn on
   *Discard client IP data*, turn off autocapture, turn off session replay, turn on *Mask all
   text*. Note the project API key.
3. Create an **UptimeRobot** account. Add two monitors: HTTP keyword on
   `https://thp.indepthwebsolutions.com/api/v1/health` for `"status":"ok"`, and HTTP on the
   sign-in page. Alert contact: the operator's e-mail.
4. Create a **Healthchecks.io** account. Add four checks — `thp-backup` (daily, 1 h grace),
   `thp-backup-check` (daily, 1 h grace), `thp-restore-drill` (90 days), `thp-worker` (5 min,
   10 min grace). Note the four ping URLs.
5. Re-read section 3 against each pricing page at sign-up and correct any number that has moved.

**The box** — over SSH, as in README.md "First setup".

6. Deploy the release that carries phase 1 — the units, the drill script and the two checks are
   in the checkout, and the `release` check will not pass a box that is ahead of a tag.
7. Follow README.md "Monitoring" on the box: install Alloy, copy the config and fill in
   `/etc/default/alloy`, create the `monitoring` role, write `/etc/thp/healthchecks.env`, recopy
   the two backup units and `daemon-reload`.
8. Run `npm run verify:production` and confirm `alloy` and `backup-pings` pass.
9. Add the PostHog and heartbeat variables from section 6.7 to `.env`, then **rebuild** —
   `NEXT_PUBLIC_POSTHOG_KEY` is inlined at build time.
10. Deploy the release that carries phases 2 and 3; it carries a migration.
11. Run `npm run verify:production` and confirm `analytics` and `heartbeat` pass.

**Grafana and PostHog** — in the browser.

12. Import the dashboard and the alert rules from `deploy/observability/`; set the contact point
    to the operator's e-mail; send a test notification.
13. Create the nine PostHog insights from section 5.4 and pin them to one dashboard.
13a. In PostHog's *Error tracking* settings, add an alert for **a new issue** to the operator's
    e-mail (A8). Prove it: with the release deployed, open a recording page and run
    `throw new Error('A8 proof')` in the browser console as a member who has not turned
    analytics off — an issue named `A8 proof` appears under *Error tracking* with `process` =
    `client` and the e-mail arrives. Resolve the issue afterwards.
13b. Web Vitals is a project setting (*Settings → Web analytics → Web Vitals*, section 5.7) and
    is already on. Prove the client side: a `$web_vitals` event appears in the live view within
    ten seconds of a page load, carrying `$web_vitals_LCP_value` and no `$current_url` in or
    beside its metric objects.
14. Prove the alerts: stop the worker with `pm2 stop thp-worker`, wait ten minutes, confirm A2 and
    A3 arrived, start it again, confirm both resolved.

**Afterwards.**

15. Add PostHog and Grafana Labs to the privacy policy before the store listings are submitted.
16. The morning after: confirm A6 did not fire.
17. Once a month, glance at PostHog's usage page against section 4. The number to watch is events;
    the action if it approaches the cap is to sample `$pageview` before anything else.

## 9. Deferred, with a home

- **Web Vitals attribution.** The metrics themselves are on (section 5.7); attribution — which
  element was slow, which resource — is off, because it names URLs. One metric's attribution is
  one entry in `web_vitals_attribution` plus a deliberate widening of the sanitiser, when a slow
  number needs diagnosing. Client error tracking and the metrics, which used to sit here, are on
  since 24 October 2026 (sections 5.6, 5.7).
- **Playback delivery events** (time to first audio, stalls, errors, grant renewals, seeks). The
  first draft specified them in full; they are not on the question list. If the 2-second start
  promise in project prd 6.2 is ever doubted, `playback_first_audio` with `start_delay_ms` is the
  first one back.
- **Push notification opens.** `notification_opened` counts the in-app centre only. Opens from an
  OS notification land on the target page directly; counting them needs a query parameter the push
  payload sets and the page reads, and belongs with the push work.
- **A play log** (project prd 3.2.7) would give streams and listeners a database counterpart and a
  cross-check. Until it exists PostHog is the record, with a year of retention.
- **Showing completed teachings when browsing** (the second half of project prd 3.2.8) reads
  `completed_at` and is product work, not analytics.
- **OpenTelemetry, traces and shipped logs.** Removed in section 2.5. If a slow request ever needs
  explaining beyond what the correlation id in the pm2 logs gives, the first draft's phase 2 is in
  git history and attaches to Alloy without changing anything in this plan.
- **Session replay** stays off. It is the one PostHog feature that could capture private content.
- **Chat alerting** (Slack, Telegram, Discord) is a contact point away in every tool here; e-mail
  is enough for one operator.
- **If a free tier goes away.** Grafana Cloud is replaced by a self-hosted Prometheus and Grafana on
  the box with a change to Alloy's config, at the cost of about 1 GB of RAM. PostHog is replaced by
  a home-grown `analytics_event` table behind the same adapter, losing the dashboards and keeping
  the data. Neither touches the event vocabulary or any call site.
