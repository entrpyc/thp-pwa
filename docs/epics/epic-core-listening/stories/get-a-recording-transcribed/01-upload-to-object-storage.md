# Ticket 01 — Upload to object storage
_Story: Get a recording transcribed_

> Phase 6 artefact for [implementation plan § Ticket 01](docs/epics/epic-core-listening/implementation-plan.md#L123).
> Sections pulled: [epic prd § In scope → 2](docs/epics/epic-core-listening/prd.md#L52);
> [3.2.1](docs/project/prd.md#L62) — Admin-only in this epic;
> [epic architecture § Media store](docs/epics/epic-core-listening/architecture.md#L164);
> [epic architecture § Data model (epic)](docs/epics/epic-core-listening/architecture.md#L193) — *The spine*;
> [epic architecture § Key choices](docs/epics/epic-core-listening/architecture.md#L255) — "Two inputs this epic needs
> and nothing defines", item 2; [§6](docs/project/prd.md#L724) Security; [4.2](docs/project/prd.md#L513);
> [project architecture § Key technology choices](docs/project/architecture.md#L209) — the object-storage row.
> Carried in because this ticket touches them:
> [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323) (the allowlist, the second
> media pointer), [epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341),
> [3.1.2](docs/project/prd.md#L44) and [3.1.5](docs/project/prd.md#L47).

**This is the first ticket that puts infrastructure outside the application under the product.** Until
now every dependency was Postgres or SMTP. The object store is the third, and two of its properties
are settled here and expensive to revisit later: **the bucket is never publicly readable**, and
**nothing is ever deleted from it** ([3.4.9](docs/project/prd.md#L102)). Both are invisible from inside the
application — no route reads them, no type encodes them — which is why the acceptance criteria below
drive them against a real S3-compatible store rather than asserting them in prose.

The other thing worth naming up front: **bytes never pass through the application**, in either
direction. The browser `PUT`s to the store on a grant the API mints, and the API learns what was
uploaded by asking the store, not by being told by the client. That is what makes "re-checked
server-side" meaningful when the API never sees the file.

---

## Goal

An admin uploads an audio file with a title and the date it was recorded. The browser `PUT`s the
file straight to object storage on a presigned URL, the API finalises that upload into a `recording`
row, and the recording appears in an admin recordings list. Nothing is member-visible and nothing
downstream is triggered.

- As an admin I want to upload an audio file with a title and the date it was recorded, so the
  recording exists in the product.
- As an admin I want to be told the size ceiling and the accepted formats **before** I choose a file,
  so an oversized export fails immediately rather than after a long upload.
- As an admin I want to see every recording that has been uploaded in one list, so I can tell what is
  already in the system.

## Out of scope

- **The job ledger, the queue port and the worker** — Ticket 02. Finalising an upload enqueues
  nothing; [3.5.1](docs/project/prd.md#L112)'s "transcription triggers on upload completing" is wired in Ticket 03,
  and this ticket deliberately leaves that edge unconnected.
- **Transcription, transcripts, segments** — Ticket 03.
- **Playback of any kind** — no signed `GET` is minted, no range request is served, no `<audio>`
  element exists. Story 4 Ticket 02 owns the read direction.
- **`description` generation, `summary`, `review_item`** — Story 3. The column ships nullable and
  nothing in this ticket writes it.
- **Publish and unpublish** — Story 3 Ticket 04. `published_at` ships as a nullable column and
  nothing writes it ([3.2.2](docs/project/prd.md#L63), [3.2.11](docs/project/prd.md#L72)).
- **Series** — Story 6. No `series` table and no `series_id` column; a recording with no series is the
  only kind there is ([3.3.9](docs/project/prd.md#L86)).
- **Duration, and any inspection of the media itself** — [§3.4](docs/project/prd.md#L88) is deferred whole
  ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)), and there is no
  FFmpeg, no probe and no processed rendition.
- **Replacing the audio on an existing recording** ([3.2.10](docs/project/prd.md#L71)), and editing or deleting
  a recording after it is created.
- **Any delete path against the bucket** — no orphan sweeper, no lifecycle rule, no cleanup job.
- **Resumable or multipart upload**, background upload, and resuming a part-finished upload across a
  page reload. One `PUT`, one grant.
- **CDN, cache headers, edge anything** ([epic architecture § Deliberately deferred](docs/epics/epic-core-listening/architecture.md#L341)).
- **Any member-visible surface.** Nothing renders outside `/admin`.
- **A fifth entry on the unauthenticated allowlist.** Both new routes require a session.

## User prerequisites

- An **R2 bucket (or any S3-compatible bucket) that is not publicly readable**, with an access key id,
  secret access key, endpoint, bucket name and region — five values for the deployment's `.env`.
  Needed for manual validation; the automated suite does not use them.
- A **CORS rule on that bucket** permitting `PUT` and its preflight from the application origin, with
  `content-type` on the allowed-headers list. Without it the browser `PUT` cannot be made at all.
- **Docker running**, for the MinIO container the suite and local development use — the same
  prerequisite the Postgres container already carries.

## Acceptance criteria

### The `recording` table

- `recording` exists with `id`, `original_media_key`, `title`, `recorded_at`, `published_at`,
  `description` and `created_at`, and with `duration`, `processed_media_key` and `series_id` **absent**
  — verified by a migration test asserting the exact column set, in the shape the existing migration
  tests use.
  - A new numbered SQL migration beside the existing four, and the table added to the Drizzle schema.
  - `published_at` and `description` are nullable and nothing in this ticket writes either; the
    absent columns are the seams [epic architecture § Extension points](docs/epics/epic-core-listening/architecture.md#L323)
    names, and a nullable column added "for later" is how deferral quietly stops being deferral.
- `original_media_key` is unique — verified by asserting a second row carrying the same key is refused
  at the database.
- Existing tables are untouched by the migration — verified by asserting the account tables' column
  sets are unchanged after it runs.

### The media store port

- Every call to the object store goes through one module, and nothing else in the repository imports
  the S3 SDK — verified by a new guard test in `tests/guards/`, the same shape as the mail-boundary
  guard.
  - One `MediaStore` port with a real S3 adapter behind it; the vendor is named in configuration and
    nowhere in code.
- The port issues a presigned `PUT` bound to a server-minted key and the declared content type,
  expiring one hour after issue — verified by an integration test that signs, `PUT`s against MinIO
  with that content type, and asserts the object lands.
- A `PUT` that presents a different content type from the one signed is refused by the store —
  verified by repeating the `PUT` with a changed `content-type` header and asserting it fails.
- A grant past its expiry is refused — verified by signing with a deliberately short expiry and
  asserting the store refuses the `PUT`.
- The key is minted server-side and is not derived from the client's filename — verified by asserting
  two presign requests naming the same filename come back with different keys.
- The store's configuration is read through one env module with no defaults, and a missing value is a
  startup failure naming the variable — verified by a unit test over the reader, matching the mail
  env tests.

### The bucket's access posture — [§6](docs/project/prd.md#L724) Security

- An object in the bucket is **not readable without a signature** — verified by an integration test
  that uploads an object and then fetches its unsigned URL, asserting the store refuses.
- The bucket answers a CORS preflight for `PUT` from the application origin — verified by an
  integration test issuing the `OPTIONS` preflight and asserting the response permits the method and
  the `content-type` header.
- Nothing is deleted from the store — verified by a guard assertion that no delete operation exists on
  the port's interface, so "the original is never deleted" ([3.4.9](docs/project/prd.md#L102)) is a property of
  the type rather than of discipline.

### Requesting the grant — `POST /api/v1/recordings/uploads`

- Requires a session and refuses a member — verified by driving the route anonymously and as a
  member, asserting `unauthenticated` and `forbidden` respectively.
  - One new policy action, `recording.upload`, answered per role in the single rules table.
- An accepted content type and a size within the ceiling get back the presigned URL, the key and the
  expiry — verified by asserting the payload's shape and then completing a real `PUT` with it.
- A content type outside mp3 / m4a / aac / wav / flac is refused and **no grant is issued** — verified
  per rejected type, asserting the error and that the response carries no URL.
- A declared size above 200 MB is refused — verified at the boundary: exactly 200 MB is accepted, one
  byte over is refused.
- The refusal is logged with actor, action and target under the request's correlation id — verified by
  a log-capture assertion, as the existing refusal tests do.
- The unauthenticated allowlist is unchanged — verified by the existing route-sweep guard, which
  discovers both new routes from the filesystem and asserts they refuse an anonymous caller.

### Finalising the upload — `POST /api/v1/recordings`

- Presign → `PUT` → finalise creates the `recording` row and returns it — verified end to end against
  MinIO with a real audio file, asserting the persisted `original_media_key`, `title` and
  `recorded_at`, and that `published_at` and `description` are null.
- Finalisation re-checks size and content type **against the store's own metadata**, not against
  anything the client says — verified by putting an object that exceeds the ceiling at a known key,
  then finalising that key and asserting the refusal and that **no row is written**.
  - A `HEAD` against the key at finalisation is what the check reads.
- Finalising a key with no object behind it is refused and writes no row — verified by finalising an
  unused key.
- The refused object is **left in place** — verified by asserting the object still exists in the store
  after each refusal above.
- Finalising the same key twice produces exactly one row — verified by replaying the request and
  asserting the second is refused and the row count is one.
- An empty title, an absent title, an absent `recorded_at` and an unparseable `recorded_at` are each
  refused with no row written — verified per case.
- Requires a session and refuses a member — verified as for the presign route.
- One correlation id spans the presign request and the finalise request when the client carries it —
  verified by asserting the id in both responses and in the log lines for both.

### The upload screen and the recordings list

- The recordings panel is a second entry in the existing `/admin` shell and is reachable from it —
  verified by a browser test navigating from the console to the panel.
  - Composed from [style-guide.md](docs/design%20referencess%20png/style-guide.md) and the token layer,
    the carve-out [implementation plan § Design references](docs/epics/epic-core-listening/implementation-plan.md#L81)
    already grants every admin screen, since no admin reference PNG exists.
- Its stylesheet uses only design tokens — verified by the existing style-token guard, which covers
  the new module automatically.
- The screen states the 200 MB ceiling and the accepted formats **before** a file is chosen, and says
  that a 90-minute teaching fits as mp3 or m4a but not as WAV or FLAC — verified by a browser test
  asserting that text is present on load.
- A file over the ceiling, or of a rejected type, is refused **in the browser before any presign
  request is made** — verified by a browser test that selects such a file and asserts no request
  reached the presign route and that an error naming the limit and the reason is shown.
- A completed upload shows the new recording in the list without a page reload — verified by a browser
  test uploading a small real file end to end.
- A failed `PUT` leaves no row and the screen says the upload failed — verified by driving the `PUT`
  against a refusing endpoint and asserting the list is unchanged and an error is shown.
- `GET /api/v1/recordings` returns every recording, newest `recorded_at` first — verified by an
  integration test over three rows with mixed dates.
  - One new policy action, `recording.list`.
- A member calling `GET /api/v1/recordings` is refused — verified by driving it with a member session.
- The screen works at phone, tablet and desktop widths — verified by a browser test at three viewports
  asserting no horizontal overflow and that the upload control is reachable at each.

## User steps

- Create the production bucket and its access key, apply the CORS rule, and put the five values in
  the deployment's `.env` (the new block in `.env.example` names them).
- Run `npm run migrate` against any environment that already has a database.
- Upload one **real 90-minute mp3** through the console and confirm the row appears in the list — the
  ceiling and the formats have never been exercised against a genuine teaching-length file.
- Take the `original_media_key` from that row, build the object's plain URL, and confirm the store
  refuses it without a signature. This is the one property the suite proves against MinIO and not
  against the real bucket.

## Assumptions

### Major (confirmed with the operator)

- Production storage is Cloudflare R2; the code speaks plain S3 through `@aws-sdk/client-s3` and
  `s3-request-presigner` behind a `MediaStore` port and names no vendor, as the mailer speaks SMTP.
- Local development and the integration suite run against a MinIO container added to
  `docker-compose.yml`, so presigning, CORS and the unsigned-`GET` refusal are exercised for real
  rather than faked.
- No `duration` column and no inspection of the media in this ticket; duration arrives with
  transcription or with [§3.4](docs/project/prd.md#L88).
- Finalisation `HEAD`s the object and re-checks size and content type against the store's metadata,
  which is what "re-checked server-side" means when the bytes never pass through the application.
- An object whose finalisation never arrives is orphaned and left in place; there is no sweeper and no
  delete path, and the list cannot see it because it reads `recording` rows.
- The upload form asks for file, title and date recorded only; `description` ships nullable for Story
  3 and `series_id` does not exist until Story 6.
- The recordings list is a second panel in the existing `/admin` shell, newest `recorded_at` first,
  with no pagination and no filters.
- The presigned `PUT` is bound to the key and the content type and expires one hour after issue;
  presigning cannot make a URL single-use, which is why the key is minted server-side per request and
  is not guessable.

### Minor

- `recorded_at` is a SQL `date`, not a timestamp — [4.2](docs/project/prd.md#L513) calls it the date recorded
  and it is the primary sort key.
- The key shape is `originals/<uuid>.<ext>`, with the uuid unrelated to the `recording.id`, so a
  refused finalisation retried later does not have to reuse anything.
- Accepted content types are `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav` (and `audio/x-wav`),
  `audio/flac` (and `audio/x-flac`). The client checks the extension; the server checks the content
  type.
- Two policy actions, `recording.upload` and `recording.list`, rather than one `recording.manage` —
  the same split the invitation and account actions already take.
- `recorded_at` has no upper bound; a date in the future is accepted, because nothing in the PRD
  forbids one and inventing a rule here would be a rule nobody asked for.
- The presign request names the file's declared size so an oversized file is refused before the
  upload starts; that check is a convenience, and the authoritative one is the `HEAD` at finalisation.
- One new `API_ERROR_CODES` entry, `upload_invalid`, covering a key with no object behind it, an
  object that fails the re-check, and a key already finalised. Existing codes cover the rest.
- Five new environment variables under a `MEDIA_` prefix, read through one module with no defaults and
  documented in `.env.example`, matching the mail configuration's pattern.

## Edge cases

_Filled in during implementation — leave empty here._

## Implementation notes

_Filled in during implementation — leave empty here._
