# Teaching Hub — Scope: series artwork — TDD

The technical decisions for `docs/scope/prd.md`. Each refines a decision in `docs/project/tdd.md`
rather than standing on its own. Drawn: `docs/scope/diagram.svg`.

## 1. Decisions

- **1.1 Artwork is a second use of the existing media boundary, not a second boundary.** The one
  port in `@thp/media` gains nothing: a presigned `PUT`, a `head`, and a presigned `GET` are
  already exactly what artwork needs, and the import guard that refuses an S3 import outside
  `s3-store.ts` keeps covering the whole store. What is added beside `mintOriginalKey` is a key
  minter for an `artwork/` prefix — server-minted uuid, extension from the signed content type, the
  same reasoning about unguessability. **The port still has no delete**, which is what makes scope
  prd 3.1.5 replace-only rather than a policy somebody has to remember. (refines project tdd 2.5)

- **1.2 The re-encode happens in the browser, so no process and no package gains an image
  dependency.** A canvas decode, a resize to the longest-edge bound and a WebP encode, all before
  the upload grant is asked for. This is the cheapest reading of project tdd 1.1's rule that
  anything which may block belongs to the workers: resizing that never happens on the server never
  has to be a job, never enters the ledger, and never leaves a series with a cover the pipeline has
  not caught up to. The cost is stated in scope prd 3.1.2 and § 5 — the chosen file is not kept —
  and it is what buys a single object with no rendition state. (refines project tdd 1.1, 2.5)

- **1.3 The upload is the recording upload's shape, one resource down.** Two calls, because the
  bytes never pass through the API: `POST /api/v1/series/{id}/artwork/uploads` authorises, checks
  the declared type and size, mints the key and answers with a presigned `PUT`; `PUT
  /api/v1/series/{id}/artwork` re-reads the stored object with `head`, checks it against the same
  limits, and writes the pointer. A finalisation that fails the re-check writes nothing and the
  series keeps the cover it had. Nothing new is invented here — this is `POST /recordings/uploads`
  followed by `POST /recordings`, and it is deliberately recognisable as that. (refines project tdd
  2.2, 5.2)

- **1.4 A payload carries a signed URL, never a key.** Every series and recording payload that a
  surface in scope prd 3.2 reads gains an artwork URL minted for that response, after the policy
  check that response already passed, with the one-hour expiry playback already uses. Presigning is
  a local signature rather than a call to the store, so minting one per row of a listing costs
  nothing worth avoiding. The client is never given a key and never learns where the object lives,
  which is the same property project tdd 5.2 gives the audio. (refines project tdd 5.1, 5.2)

- **1.5 One new capability, `series.artwork`, and no read capability at all.** Writing a cover is
  split from `series.update` for the reason every pair in the policy is split — the day a
  Contributor may set artwork without being able to rename a study, the split stops being
  decoration, and project prd 3.1's role table already points at that day. There is no artwork read
  action, because there is nothing to read separately: the URL rides on the series or recording
  payload, and whoever was allowed that payload is allowed its cover. Admin-only in this scope,
  because the Contributor role does not exist in the policy yet. (refines project tdd 6.1)

- **1.6 The now-playing view is a route inside the member layout.** The docked transport and the
  audio element it owns live in that layout; a route beneath it re-renders the page slot and leaves
  both mounted, so scope prd 3.3.4's "opening it never interrupts the audio" is a property of where
  the route sits rather than of anything the view is careful to avoid doing. A modal over the layout
  would hold the same property and lose the back button and the shareable address; a screen outside
  the layout would remount the player and break the requirement outright. (refines project tdd 2.1)

- **1.7 The view reads the playback session, and owns none of it.** It takes what is playing from
  the same client-side player context the transport reads, and it renders the scripture list through
  the read path the recording page already uses. No new API surface, no second source of truth for
  what is playing, and no transport control duplicated onto it — which is what keeps project prd
  3.2.15's "a second view of one session rather than a second player" true in the code and not only
  in the sentence. (refines project tdd 2.1, 5.1)

- **1.8 The empty state shows nothing rather than an empty frame — and on the hero bands it is a
  new rendering, not the current one.** The listing already drops the thumbnail and the transport
  already carries a title; the seams are named in `series-listing.tsx`, `series-view.tsx`,
  `recording-view.tsx` and `transport.module.css` as artwork being deferred, and this scope fills
  all four. On those two surfaces nothing about the coverless case changes.

  **The two hero bands are the exception, decided during the build of scope plan 2.2–2.3.** The
  band was a bordered, rounded card 96 px tall, and a cover cropped into it came out a ~7:1 slice
  of its own middle — nothing `pages/series-inner.png` or `pages/chapter.png` draws. The operator
  chose the references' rendering over the smaller change: **the band is full-bleed, borderless and
  square-cornered, 3:1 with a cover behind it and fading into the page at its foot.** Coverless, it
  stays flat `--color-bg-deep` and stays a slim strip at the height it already had — so what
  changes when there is no cover is the band's frame, not its content. Still no second branch and
  still no empty frame, which is what scope prd 3.2.6 is actually about; the sentence there saying
  the bands stay as they are today was rewritten in the same run. (refines project tdd 2.1)

## 2. Data

**2.1 `Series`** _(existing, extended)_ — one nullable `artwork_key` column holding the object key of
the current cover, written only by 1.3's finalisation and read only to mint the signed URL at 1.4.
`null` is the ordinary no-cover state of scope prd 3.1.7. No width, height, byte size, content type
or uploaded-at column: the bound at scope prd 3.1.2 is enforced before the pointer is written, and a
denormalised copy of what the store already knows is a second answer to a question `head` answers.
No rendition columns, because § 5 has no renditions. (refines project tdd 3.1)

**2.2 `Recording`** _(existing, unchanged)_ — no artwork column. A recording's cover is its series'
cover, resolved through the `series_id` foreign key that is already there, which is what makes scope
prd 3.2.6's no-series case fall out of a `null` join rather than out of a rule. (refines project tdd
3.1)
