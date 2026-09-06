# Teaching Hub — Rate limits and spend ceilings

A design note, standing beside [prd.md](prd.md) and [tdd.md](tdd.md). It settles every budget the
product enforces, why each exists, what it keys on, what it refuses with, and where it lives. The
PRD amendments in section 7 are applied when the tickets in section 8 land, so until then this note
is ahead of the PRD on purpose.

Decided on 2026-09-06 with the operator. Numbers here are the agreed defaults, not proposals.

## 1. What changes and why

Today one route is rate-limited, registration, and the PRD (3.1.18) says it is the only route that
is, because it is the only unauthenticated route where "repetition is itself the abuse". A survey of
every route found four more places where that reasoning applies, and a class of spend that no
per-request limit can see at all.

| Surface                          | Today                                                    | Gap                                                                                      |
| :------------------------------- | :------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| Sign-in `POST /auth/session`     | argon2id at ~100 ms per attempt; no attempt counter      | Unbounded online guessing per account; a cheap way to pin four vCPUs                    |
| Reset request `POST /auth/password-reset` | One live reset per account, one-minute resend interval | One caller can mail every known member once per interval; timing leaks "mailed" vs "not" |
| Feedback `POST /feedback`        | Session required; every call composes and sends mail     | Any member can flood the feedback inbox                                                  |
| Avatar grant `POST /users/me/avatar/uploads` | Session required; mints a presigned PUT       | Any member can fill a store with no delete with orphans                                  |
| Recording and artwork grants     | Admin only; mints a presigned PUT                        | Same shape, smaller blast radius                                                         |
| Deepgram and MiniMax             | One generation in flight per recording; every job records its cost | Nothing bounds spend across recordings or across a day; a loop is capped only by the provider's own quota |

Two mechanisms cover all of it, and the split is the design:

1. **Request budgets** for the five routes. In-memory sliding-window counters in the web process,
   the same primitive registration already uses (`server/api/rate-limit.ts`). They refuse with `429
   rate_limited` and a `Retry-After`. They protect the server's own CPU, its mail transport and its
   store from repetition.
2. **A daily spend ceiling** for the paid providers. A durable number in the database, read by the
   worker before it starts a paid step and by the API before it enqueues one. It refuses by failing
   the job with a named reason. It protects the bill, and it has to be durable because the worker is
   a separate process, the counts must survive a restart, and the automatic upload pipeline spends
   without any admin pressing a button.

## 2. Request budgets

All five use `createRateLimiter` unchanged. Every guard is a factory over its own counters, built
lazily once per process, exactly as `sign-up-limits.ts` does, so a test can hold one nothing else
has spent from and a configuration error cannot take down the bundle at import.

### 2.1 Sign-in

- **Keys.** Two budgets, spent in order: per client address, then per normalised email. The email
  budget is spent whether or not the address has an account, so a refusal cannot say which. An
  attempt refused by the address budget does not spend the email budget, so a machine that is
  already blocked cannot lock a real member out of their own account.
- **Defaults.** 50 per address and 10 per email, in a 15-minute window. Ten wrong tries on one
  account in a quarter hour is past any honest person; fifty per address still lets a room on one
  wifi sign in together. A member who knows their password never reaches either.
- **When it applies.** Before the password is verified, so a refused attempt costs no argon2 work.
  That is the point of the limit: after it, the per-attempt cost is the attacker's problem.
- **Configuration.** `SIGNIN_RATE_LIMIT_WINDOW_SECONDS`, `SIGNIN_RATE_LIMIT_PER_IP`,
  `SIGNIN_RATE_LIMIT_PER_ACCOUNT`. Env with defaults, for the reason registration is: how many
  members sit behind one address is a fact about a congregation. The same validation rules as
  registration: positive whole numbers, refused with the variable named.
- **Refusal.** One message for both budgets: "Too many sign-in attempts. Try again in N minutes."
  Which budget ran out is in the log, never on the wire. It is logged at `warn` with
  `target: address:…` or `target: account:…`, where the account target is the SHA-256 of the
  normalised email so the log holds no address a probe supplied.
- **What it does not do.** No lockout, no lock flag on the account, nothing an admin has to clear.
  The window expires by itself. A limit that needed a person to reset it would be a way to lock
  members out on purpose.

### 2.2 Password reset request

- **Keys.** Two budgets like registration: per client address, and one across the whole route.
- **Defaults.** 5 per address and 100 across the route, in a 15-minute window. Five is generous for
  a person who genuinely cannot remember; the ceiling is what stops a distributed run from mailing
  every member once per resend interval, which a per-address budget cannot see.
- **The trade, stated.** While the ceiling is spent, nobody can request a reset. That is accepted
  for the same reason registration accepts it: a quarter hour of "try again later" is recoverable,
  and a hundred members each mailed a reset link they did not ask for is a support incident. The
  ceiling is logged at `error`; the per-address refusal at `warn`.
- **The fixed-payload rule still holds.** The route answers one payload for every outcome today so
  it cannot enumerate addresses. A `429` is a different answer, but it says nothing about the
  address in the request, only about the caller, so the rule is preserved. It also shrinks the
  sample an attacker gets for the timing difference between "mailed" and "did nothing".
- **Configuration.** `RESET_RATE_LIMIT_WINDOW_SECONDS`, `RESET_RATE_LIMIT_PER_IP`,
  `RESET_RATE_LIMIT_TOTAL`, validated as registration's are, including "total may not be below
  per-IP".
- **Not limited.** The preview `GET` and the complete `POST`. Tokens are 32 random bytes, so
  guessing is infeasible, and a limit there would buy cost control alone.

### 2.3 Feedback

- **Key.** Per actor, by user id. A session is required already, so the key is always known.
- **Default.** 5 per hour. A constant, not configuration: nothing about a deployment changes how
  many bug reports one person sends in an hour.
- **Refusal.** "You have sent several reports in the last hour. Try again in N minutes." Logged at
  `warn` with `actorId`.

### 2.4 Upload grants

- **Key.** Per actor, by user id, one counter per grant kind so an admin's recording uploads do not
  spend a budget shared with their avatar.
- **Defaults.** Avatar 10 per hour; recording 30 per hour; artwork 30 per hour. Constants. Ten
  avatar attempts in an hour is a person fighting a file picker, not a real workflow; thirty
  recordings in an hour is a bulk backfill that 3.21.3 has not built yet, and when it does it gets
  its own budget rather than borrowing this one.
- **What is limited is the grant, not the bytes.** A presigned URL is what the route mints, and an
  orphan object is what an unfinished grant costs. Playback URL minting is deliberately not limited:
  a presigned `GET` costs nothing to sign, and egress is paid only when bytes move.
- **Refusal.** "Too many upload attempts. Try again in N minutes." Logged at `warn` with `actorId`
  and the grant kind.

### 2.5 The refusal on the wire, everywhere

`ApiError.rateLimited` as it exists: `429`, code `rate_limited`, `Retry-After` in whole seconds
rounded up, the wait spelled into the message. Clients already know this shape from registration
and the sign-up screen renders it; the sign-in and reset screens get the same treatment in the
tickets below.

### 2.6 What every counter shares

- One process holds the counts, and that is the true count only because `ecosystem.config.cjs` runs
  the web app as a single fork. This is already a documented property; the new limits inherit it
  and the note in `.env.example` is extended rather than repeated.
- Client address comes from `clientAddress(request)`, and the one-per-process warning when no proxy
  header is present is shared, not re-implemented.
- `MAX_TRACKED_ADDRESSES` stays at ten thousand for address-keyed limiters. Actor-keyed limiters cap
  at one thousand, which is ten times the membership.

## 3. The daily spend ceiling

### 3.1 What is counted

Every job the worker runs already writes what it cost into `job.provider_meta.costUsd` on success,
from the provider's own billed quantity. Today's spend is therefore one query:

```sql
select coalesce(sum((provider_meta->>'costUsd')::numeric), 0)
from job
where status = 'succeeded'
  and finished_at >= date_trunc('day', now() at time zone 'utc')
  and provider_meta ? 'costUsd';
```

One number across both providers, because that is what the operator raises: a day's budget for
"paid work", not a ledger per vendor. The pipeline view still shows the per-provider split, since
the rows carry `provider`.

A day is a UTC day. The worker and the API both compute "today" the same way, in the database,
so a clock difference between the two processes cannot open a second budget.

Failed jobs count nothing, because a provider that failed billed nothing we can read. This is
slightly generous and deliberately so: the alternative is guessing a cost for a call that returned
an error.

### 3.2 The ceiling in force

The ceiling on any given day is the larger of two numbers:

1. **The configured default.** `SPEND_CEILING_USD_PER_DAY`, env with a default of **2**. Read by
   both the worker and the web app from the shared `.env`. Two dollars is roughly five full
   teachings through Deepgram, which is more than any real week, and small enough that a runaway
   loop is capped at pocket money.
2. **Today's raise, if there is one.** A row in a new `spend_ceiling_raise` table:

   | Column        | Type          | Meaning                                              |
   | :------------ | :------------ | :--------------------------------------------------- |
   | `day`         | `date`, PK    | The UTC day it applies to                            |
   | `ceiling_usd` | `numeric`     | The ceiling for that day                             |
   | `raised_by`   | `uuid` → user | Who raised it                                        |
   | `raised_at`   | `timestamptz` | When                                                 |
   | `reason`      | `text`, null  | Optional; shown in the pipeline view next to the raise |

   One row per day, upserted, so raising twice in a day keeps the higher number and the latest
   author. A raise below the configured default is refused with `invalid_input` naming the floor.
   Tomorrow starts back at the default with no cleanup, because tomorrow's row does not exist.

Both readers, `packages/db/src/spend.ts`, expose the same two functions: `readSpendToday()` and
`readSpendCeilingToday()`. The env default is read where every other env is, and passed in, so the
database layer stays free of configuration.

### 3.3 Where it is enforced

**In the worker, before the provider is called.** `run-job.ts` asks, for a step that spends
(`transcribe`, `generate_draft`, `generate_chapters`; `process_audio` is ffmpeg and free), whether
today's spend is already at or over the ceiling. If it is, the job is failed with the reason
`spend ceiling reached: $X of $Y today` and the chain stops, exactly as any other failure does
(3.21.2.3, 3.21.2.5). Nothing is called, nothing is billed, and the job is re-runnable through the
existing control once the ceiling is raised or the day rolls over.

The check is *before* the call, on the running total *before* this job. A job that starts under the
ceiling and finishes over it is allowed to finish; a ceiling that could refuse a call mid-flight
would still be billed for it. So the true cap is the ceiling plus one job, and that is stated here
rather than hidden.

**In the API, before the enqueue.** `rerunStep`, `regenerateReview` and `regenerateSummary` ask the
same question and refuse with a new `409 spend_ceiling_reached` carrying today's spend and the
ceiling, so an admin pressing the button learns why now rather than by reading a failed row a
minute later. The automatic enqueue on upload finalisation does **not** check: the upload has
already happened, the job belongs in the ledger, and it will fail with the named reason if the
ceiling holds when the worker reaches it. Refusing the enqueue there would lose the job.

Why both: the worker check is the one that protects the bill and must exist; the API check is a
courtesy that turns a delayed failure into an immediate answer.

### 3.4 What an over-ceiling failure looks like

- The job row: `status = failed`, `error = "spend ceiling reached: $2.14 of $2.00 today"`.
- The log: `job.failed` at `error`, once per job, with `reason: spend-ceiling-reached`, `spentUsd`,
  `ceilingUsd`. Also `spend.ceiling.reached` at `error` the first time in a day it is hit, so an
  operator reading the log sees one event and not a pile.
- The pipeline view: the failed step's existing error text shows it, and the panel header shows
  today's spend against the ceiling so the admin sees the cause and the fix together.

### 3.5 The raise in the UI

On the admin pipeline page, above the recording list:

```
Spend today   $2.14 of $2.00          Deepgram $1.98 · MiniMax $0.16
Ceiling reached. Paid steps fail until it is raised or the day ends (UTC, in 6 h 12 m).

Raise today's ceiling to  [ 5.00 ] USD   Reason (optional) [ Backfilling March ]   [Raise]
```

- `GET /api/v1/pipeline` gains a `spend` field: `{ todayUsd, ceilingUsd, defaultUsd, byProvider,
  raise: { ceilingUsd, raisedBy, raisedAt, reason } | null, dayEndsAt }`. One payload, one refresh
  loop, no new polling.
- `PUT /api/v1/pipeline/spend-ceiling` with `{ ceilingUsd, reason? }`. Admin only, behind a new
  policy action `spend.raise` with `admin: true, member: false`. Refuses below the floor with
  `invalid_input`, and above an absolute cap of 100 USD with the same code, because a typo of 500
  should not be a valid instruction. Answers the same `spend` shape as the list.
- Logged at `warn` as `spend.ceiling.raised` with `actorId`, `fromUsd`, `toUsd`, `reason`.
- The form is visible only to admins and only shows the "ceiling reached" line when it is reached;
  the spend line is always there, because the number is worth seeing before it is a problem.

### 3.6 What it is not

- Not a per-provider budget. One number, because that is what a person reasons about on a day.
- Not a lockout of the pipeline. Free steps still run; paid ones fail individually and re-run
  individually.
- Not a monthly cap. Section 8 of the TDD holds the monthly expectations; a day's ceiling is the
  unit at which a runaway is noticed and stopped.
- Not retried by itself. 3.21.2.5 already says nothing retries unattended, and a job that failed
  for budget is not an exception to it.

## 4. Configuration summary

| Variable                          | Default | Read by      | Notes                                       |
| :-------------------------------- | :------ | :----------- | :------------------------------------------ |
| `SIGNIN_RATE_LIMIT_WINDOW_SECONDS` | 900     | web          |                                             |
| `SIGNIN_RATE_LIMIT_PER_IP`        | 50      | web          |                                             |
| `SIGNIN_RATE_LIMIT_PER_ACCOUNT`   | 10      | web          | May not exceed per-IP                       |
| `RESET_RATE_LIMIT_WINDOW_SECONDS` | 900     | web          |                                             |
| `RESET_RATE_LIMIT_PER_IP`         | 5       | web          |                                             |
| `RESET_RATE_LIMIT_TOTAL`          | 100     | web          | May not be below per-IP                     |
| `SPEND_CEILING_USD_PER_DAY`       | 2       | web, worker  | The floor a raise cannot go under           |

Constants, in code beside their reasoning: feedback 5/hour, avatar grants 10/hour, recording and
artwork grants 30/hour, raise cap 100 USD.

Every variable is documented in `.env.example` in the same voice as the registration block, and the
"one process holds these counts" note there is extended to cover the new counters.

## 5. Testing

- **Unit.** Each guard factory with a budget of three and a fixed clock, driving the refusal and
  the `retryAfterMs` for real, as `rate-limit.test.ts` and `sign-up-rate-limit.test.ts` do. The spend reader against a
  hand-built set of job rows: succeeded and failed, today and yesterday, with and without
  `costUsd`.
- **Integration.** The sign-in route with `SIGNIN_RATE_LIMIT_PER_ACCOUNT=3`: three wrong passwords
  then a `429` for the right one, then a `201` after the window. The reset route's ceiling with
  `RESET_RATE_LIMIT_TOTAL=3`. Feedback and avatar grant with their constants, using a test-only
  override so the suite does not send six requests to prove the seventh fails. The worker with a
  fake provider that reports a cost: two jobs under a ceiling of 1 USD, the second failing with the
  named reason and the provider never called. The raise route: below floor refused, above cap
  refused, valid raise reflected in the list payload and honoured by the worker on the next claim.
- **The route sweep** is untouched. Nothing here adds a public route.

## 6. Operational notes

- Reaching the reset ceiling, the sign-in address budget, or the spend ceiling are the events an
  operator should be looking at, and each is logged at `error` once. Per-actor refusals are `warn`.
- The spend line on the pipeline page is the first place the running cost 3.19.13 promised becomes
  visible without a database query.
- `npm run verify:production` gains one check: the ceiling env parses and the `spend_ceiling_raise`
  table exists.

## 7. PRD amendments

Applied when the tickets land. Section 3.1:

- **3.1.18** loses "and it is the only route in the product that is" and the clause that follows
  it, and gains a pointer: "It is one of four rate-limited routes; see 3.1.20."
- **3.1.20** (new). Sign-in is rate-limited per caller and per account, so that an online guessing
  run is bounded whether it comes from one machine or many, and so that the deliberate cost of
  verifying a password is spent only on attempts the budget allowed. A refused attempt verifies
  nothing and answers with the wait. There is no lockout and nothing for an admin to clear.
- **3.1.21** (new). A password-reset request is rate-limited per caller, with a ceiling across the
  route that closes reset requests for everyone while it is spent, for the same trade 3.1.19
  accepts on registration.
- **3.1.22** (new). Feedback and every upload grant are budgeted per account, at rates no honest use
  reaches, so that a member cannot make the product send mail or mint storage on a loop.

Section 3.19:

- **3.19.16** (new). The processing view shows what paid work has cost today against a daily
  ceiling, and an admin can raise the ceiling for the rest of that day, with the raise recorded
  against them.

Section 3.21.2:

- **3.21.2.8** (new). Paid steps run only while the day's spend is under a ceiling. A step reached
  after the ceiling fails naming the ceiling, spends nothing, and is re-run through 3.21.2.4 once
  the ceiling is raised (3.19.16) or the day ends. The ceiling is a deployment setting with a
  default, and the raise is bounded so it cannot be mistyped into no ceiling at all.

TDD, section 6, a new **6.x Budgets** paragraph naming the two mechanisms and why the spend ceiling
is durable while the request budgets are not. Section 8.2 gains a line noting the daily ceiling as
the operational cap on the transcription and generation rows.

README: the "Every route requires a session" paragraph already lists exceptions; the rate-limit
sentence beside it lists the four limited routes and links here.

## 8. Tickets

In order. Each is one PR with its tests and its docs, and each leaves the product deployable.

1. **Sign-in budgets.** ✅ Landed 2026-09-06. `server/auth/sign-in-limits.ts`, wired into the
   session route ahead of `signIn`. The helpers registration and sign-in share — reading a budget
   from the environment, describing a wait — moved to `server/api/budgets.ts`. Env,
   `.env.example`, PRD 3.1.18 and 3.1.20, README. The sign-in screen already printed the API's
   message for any refusal, so it needed no change to show the wait.
2. **Reset budgets.** `server/password-reset/limits.ts`, same shape. Reset screen handles `429`.
   PRD 3.1.21.
3. **Per-actor budgets.** One `server/api/actor-limits.ts` holding the four constants and a
   `spendFor(kind, actorId)` guard, wired into feedback and the three grant services. PRD 3.1.22.
4. **Spend ledger and worker ceiling.** Migration `0025_spend_ceiling_raise.sql`, `db/src/spend.ts`,
   env in both processes, `run-job.ts` check, named failure. PRD 3.21.2.8, TDD 6.x and 8.2.
5. **Spend in the API and the UI.** `spend` on the pipeline payload, the refusal on rerun and
   regenerate, the raise route and policy action, the pipeline panel header and form. PRD 3.19.16.
   `verify:production` check.
