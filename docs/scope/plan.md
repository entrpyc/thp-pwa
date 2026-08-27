# Teaching Hub — Implementation plan: series artwork

## Status

34/65 criteria met.
_Maintained by the build phase — see the checkboxes for detail._

---

## 1. A cover, stored and shown (Foundation)

**Delivers:** an admin picks an image on a series row in the console and that row carries the cover afterwards — the write path, the read path and the surface, thin but whole, so building it by hand shows how every later surface gets its artwork.
**Features:** scope prd 3.1, 3.2
**Fixes for the scope:** the nullable `artwork_key` pointer on the existing series row; an `artwork/` key minter on the one media port, still with no delete beside it; the two-call upload contract (`POST …/artwork/uploads` then `PUT …/artwork`) and the `series.artwork` capability that gates both; the browser re-encode that bounds what is ever stored; and `artworkUrl` — a signed URL minted per response, never a key — as the single way artwork reaches any surface in the product.

### 1.1 — The pointer and the key

**Delivers:** a series row that can hold a cover, and a media port that can name one.
**References:** scope prd 3.1.7; scope tdd 1.1, 2.1, 2.2
**Touches:** `packages/db/src/schema.ts` (the `series` table and the comment that currently says "No `artwork_key`, because 3.3.3 is deferred"), `packages/db/drizzle/0016_series_artwork.sql` and `packages/db/drizzle/meta/_journal.json` (both generated), `packages/db/src/series.ts`, `packages/db/src/index.ts`, `packages/media/src/store.ts`, `packages/media/src/index.ts`, `packages/shared/src/artwork.ts` (new — the accepted-image vocabulary the minter reads, the shape `recordings.ts` gives audio), `packages/shared/src/index.ts`, `packages/db/tests/integration/migrations.test.ts`, `packages/db/tests/integration/series.test.ts`, `packages/media/tests/unit/artwork-key.test.ts` (new), `tests/guards/media-boundary.test.ts`
**Out of scope:** nothing reads or writes the pointer over HTTP yet — that is 1.2 and 1.3.

**Acceptance criteria**

- [x] **1.1.1** The `series` table carries a nullable `artwork_key` text column, and the table's column set is otherwise exactly what it was. — verified by `packages/db/tests/integration/migrations.test.ts`
- [x] **1.1.2** A series inserted without artwork reads back `artworkKey` as `null`. — verified by `packages/db/tests/integration/series.test.ts`
- [x] **1.1.3** `setSeriesArtwork` points a series with no cover at a key. — verified by `packages/db/tests/integration/series.test.ts`
- [x] **1.1.4** `setSeriesArtwork` on a series that already has a cover replaces the key with the new one. — verified by `packages/db/tests/integration/series.test.ts`
- [x] **1.1.5** `setSeriesArtwork` leaves the series' title and description exactly as they were. — verified by `packages/db/tests/integration/series.test.ts`
- [x] **1.1.6** `setSeriesArtwork` returns `null` for an id that is not a series, and writes nothing. — verified by `packages/db/tests/integration/series.test.ts`
- [x] **1.1.7** `mintArtworkKey('image/webp')` returns a key under the `artwork/` prefix ending `.webp`, with a server-generated uuid as its name. — verified by `packages/media/tests/unit/artwork-key.test.ts`
- [x] **1.1.8** `mintArtworkKey` throws for a content type outside the accepted image types rather than minting a key it cannot name the format of. — verified by `packages/media/tests/unit/artwork-key.test.ts`
- [x] **1.1.9** Nothing outside `packages/media/src/s3-store.ts` imports the S3 SDK, with the artwork minter added, and the `MediaStore` interface still exposes no delete. — verified by `tests/guards/media-boundary.test.ts`

**Assumptions**

- **The accepted image content types are exactly `image/webp`, `image/jpeg` and `image/png`, and the extensions their keys end in are `webp`, `jpg` and `png`.** — minor. One table in `packages/shared/src/artwork.ts`, the shape `recordings.ts` already gives audio, with both directions derived from it rather than restated.
- **`image/jpg` is not accepted, unlike the `audio/x-wav` alias the audio table tolerates.** — minor. No browser reports it for a file a person picked, so accepting it would widen what the store can hold on the strength of a request nobody legitimate makes.
- **The artwork vocabulary is a new module in `@thp/shared` rather than more of `series.ts`.** — minor. It is read by the media port, which has no business importing series paths.

**Edge cases**

- This layer never checks that a key it is given has an object behind it. A caller that writes a key for nothing leaves a series whose cover fails to load — the operator sees a broken image frame rather than the clean no-cover rendering. 1.2's finalisation is what makes that unreachable from the API.
- Two finalisations on the same series at the same moment: last write wins silently, no conflict detection. Whichever landed second is the cover, and the other admin's upload is an orphan nobody is told about.
- Nothing sweeps orphaned artwork objects. Every replacement leaves one behind for good, so storage grows by one image per replacement and no screen or report ever shows it.

**Manual steps**

- Run `npm run migrate` to apply `0016_series_artwork`. Without it every series read fails on a missing `artwork_key` column — the series console and the member series screens both error rather than degrade.

### 1.2 — The write path

**Delivers:** two authorised calls that put an image in the bucket and point a series at it, refusing before either happens when they should.
**References:** scope prd 3.1.3, 3.1.4, 3.1.5, 3.1.8, 3.1.9, 4.2; scope tdd 1.1, 1.3, 1.5
_scope prd 3.1.9 was added during the build, when the operator raised the ceiling; it is covered here because the grant and the finalisation are the two places it is checked, and 1.2.4 and 1.2.6 already test both._
**Touches:** `packages/web/src/server/auth/policy.ts`, `packages/web/src/server/series/service.ts`, new `packages/web/src/app/api/v1/series/[id]/artwork/uploads/route.ts`, new `packages/web/src/app/api/v1/series/[id]/artwork/route.ts`, `packages/shared/src/series.ts`, `packages/shared/src/index.ts`, `packages/web/src/server/recordings/service.ts` (`grantUpload` is the shape being followed), new `packages/web/tests/integration/series-artwork.test.ts`, new `packages/web/tests/support/artwork.ts`, `packages/web/tests/unit/policy.test.ts`, `packages/web/tests/integration/route-sweep.test.ts`, `tests/guards/route-access-typecheck.test.ts`
**Out of scope:** no screen calls either route yet; nothing renders the stored image.

**Acceptance criteria**

- [x] **1.2.1** `POST /api/v1/series/{id}/artwork/uploads` refuses a member. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.2** It answers an admin with a presigned `PUT` bound to a server-minted `artwork/` key and to the content type the grant was signed for. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.3** A declared content type outside JPEG, PNG and WebP is refused, and the answer carries no URL at all. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.4** A declared size over the ceiling is refused, and the answer carries no URL at all. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.5** `PUT /api/v1/series/{id}/artwork` writes the pointer after re-reading the stored object's size and content type from the store rather than from the request. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.6** Finalising a key whose stored object exceeds the ceiling leaves the series' cover as it was. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.7** Finalising a key with nothing behind it leaves the series' cover as it was. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.8** Finalising a second cover on the same series repoints it at the new key, and the earlier object is still readable in the store. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.9** `PUT /api/v1/series/{id}/artwork` refuses a member. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.2.10** `series.artwork` is a capability of its own, permitted to admin and refused to member, and distinct from `series.update`. — verified by `packages/web/tests/unit/policy.test.ts`

**Assumptions**

- **The two calls are `POST /api/v1/series/{id}/artwork/uploads` and `PUT /api/v1/series/{id}/artwork`, both gated by one `series.artwork` action.** — major, hard to change later: the client, the routes and the policy table all bind to both. One action rather than two because a grant nobody may finalise is a grant nobody should have been given.
- **Finalisation is `PUT`, not `POST`, and there is no `DELETE` beside it.** — major, user-facing: naming the same key twice is a no-op and naming a different one replaces the pointer, which is the whole of scope prd 3.1.5. Nothing on the resource can return a series to having no cover.
- **The ceiling is 4 MB, checked twice: against the declared size in the grant, and against the store's own metadata at finalisation.** — major, user-facing: it was 2 MB until 1.4 hit an image the re-encode could not bring under it, and raising it was the operator's call (scope prd 3.1.9, § 6). Not checked a third time on the screen, because the screen is what produces the bytes — an image the encoder makes too large is refused by the grant, which is where the number lives.
- **A grant is refused for a series id that does not exist, before any key is minted.** — minor. A key in the bucket for a series nobody can name is an orphan with no owner at all.
- **The finalisation re-reads the series after writing, so its response carries the same `SeriesView` every read answers with.** — minor. One extra query, and it keeps the console from having two ideas of what a series is.

**Edge cases**

- A grant is not tied to the series it was minted for. An admin could finalise a key granted against series A onto series B, and both series would then name the same object; the second one would simply show the first one's cover. Reachable only by hand-crafting requests, and the log line names the series each grant was issued against.
- A finalisation naming a key that belongs to a *recording* (`originals/…`) is refused for its content type, not for its prefix, so the message read is "not an image this accepts" rather than anything about keys.
- A refused finalisation leaves the uploaded object in the bucket for good. The admin sees the refusal and re-uploads; nothing tells them the rejected image is still stored.
- Two admins finalising different covers on one series at the same moment: last write wins silently. The loser sees a success response for a cover that is no longer the series'.

**Manual steps**
_None._

### 1.3 — The read path

**Delivers:** every series payload carries a signed artwork URL or `null`, and never a key.
**References:** scope prd 3.1.6, 4.2; scope tdd 1.4
**Touches:** `packages/db/src/visibility.ts` (`VisibleSeriesRow`, `listVisibleSeries`, `findVisibleSeries`), `packages/web/src/server/series/service.ts` (`describe`, `describeNew`, `listSeriesFor`, `readSeriesFor`), `packages/web/src/server/playback/grant.ts` (the minting shape being followed), `packages/shared/src/series.ts` (`SeriesView`), new `packages/web/tests/unit/artwork-grant.test.ts`, `packages/web/tests/integration/series-artwork.test.ts`, `packages/web/tests/integration/series-browse.test.ts`, `packages/web/tests/integration/series-management.test.ts`, `tests/guards/visibility-boundary.test.ts`
**Out of scope:** the recording payload's copy of the same field — that is 2.3, because nothing renders it before then.

**Acceptance criteria**

- [x] **1.3.1** A series with a cover answers `artworkUrl` as a fetchable signed URL on the console series list. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.3.2** The same series answers `artworkUrl` on the member series list. — verified by `packages/web/tests/integration/series-browse.test.ts`
- [x] **1.3.3** The same series answers `artworkUrl` on its own detail payload. — verified by `packages/web/tests/integration/series-browse.test.ts`
- [x] **1.3.4** A series with no cover answers `artworkUrl` as `null` on all three. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.3.5** No series payload from any of the three carries the object key, under that name or any other. — verified by `packages/web/tests/integration/series-artwork.test.ts`
- [x] **1.3.6** The minted artwork URL is signed for an expiry of 3600 seconds. — verified by `packages/web/tests/unit/artwork-grant.test.ts`

**Assumptions**

- **Every cover URL in the product is minted by one function, `mintArtworkGrant`, which takes the store as an argument with a default.** — major, produces code later steps bind to: step 2's four surfaces and step 3's square all read a cover through payloads this function filled, and the injectable store is what lets the expiry be asserted against a port rather than a clock.
- **There is no artwork read capability in the policy table.** — major, changes the technical decisions: whoever was allowed the series payload is allowed its cover, so the grant authorises nothing of its own. A separate read action would be a second answer to a question the payload's own check already settled.
- **`SeriesView` gains `artworkUrl` and no other field — no width, no content type, no expiry.** — major, hard to change later: it is the shape every surface in steps 2 and 3 binds to.
- **A listing mints one signature per row rather than one per request.** — minor. Presigning is a local HMAC and never a call to the store, so a page of series costs no round trips.
- **A rename answers with the cover the series already had rather than `null`.** — minor. `describeNew` reads the row it was handed, so the console's rename does not appear to blank the cover.

**Edge cases**

- A page held open for over an hour has cover URLs that have expired. Images that were already painted stay painted; a hard refresh re-mints them, but an image re-requested by the browser in between shows as broken rather than as absent.
- The signed URL necessarily carries the object key in its path — that is what a presigned `GET` is. What is asserted is that no payload *field* carries the bare key; anyone reading a URL out of a network tab can still see what the object is called until it expires.
- `mintArtworkGrant` does not ask whether the object behind the key exists. A series pointed at a missing object answers a perfectly valid URL that 404s, and the surface shows a broken frame rather than no frame.

**Manual steps**
_None._

### 1.4 — The console: choose it, shrink it, send it, see it

**Delivers:** the end-to-end press — an admin sets a cover from the series console and the row shows it, with the browser bounding the image before a byte leaves the device.
**References:** scope prd 3.1.1, 3.1.2, 3.2.5, 4.1, 4.3; scope tdd 1.2; design-references/pages/series-listing.png; design-references/style-guide.md
**Touches:** new `packages/web/src/client/artwork/encode.ts`, `packages/web/src/app/admin/series/series-panel.tsx`, `packages/web/src/app/admin/series/series.module.css`, `packages/shared/src/artwork.ts` (the accepted-type list the file input's `accept` is built from), new `packages/web/tests/unit/artwork-encode.test.ts`, `packages/web/tests/integration/series-management-screen.test.ts`, `tests/guards/style-tokens.test.ts`. Not `packages/web/src/client/api-client.ts` — the `PUT` to the store is a bare `fetch` because it goes to the bucket rather than to the API, and `packages/web/tests/support/artwork.ts` is 1.2's synthesised bytes, not this substep's: the browser builds a real PNG with a canvas.
**Out of scope:** every member surface — the console row is the only place the cover appears at the end of this step.

**Acceptance criteria**

- [ ] **1.4.1** The encoder reduces a 4000×3000 source to a longest edge of 2000 px. — verified by `packages/web/tests/unit/artwork-encode.test.ts`
- [ ] **1.4.2** The encoder preserves the source aspect ratio: a 4000×3000 source comes out 2000×1500, not squared. — verified by `packages/web/tests/unit/artwork-encode.test.ts`
- [ ] **1.4.3** The encoder leaves a source already inside the bound at its own dimensions rather than upscaling it. — verified by `packages/web/tests/unit/artwork-encode.test.ts`
- [x] **1.4.4** What reaches the bucket is one WebP under the 4 MB ceiling, however large the image the admin chose was. — verified by `packages/web/tests/integration/series-management-screen.test.ts`
      _Re-pointed during the build: a canvas cannot be driven from Node, so the unit suite covers the sizing rule (1.4.1–1.4.3) and the format-and-bytes property is asserted in the browser against the real store, which is the stronger reading of it anyway._
      _Ceiling raised from 2 MB to 4 MB during the build, by the operator, after a worst-case source (pseudo-random pixels) re-encoded to 3 MB at 2000 px and the API refused its own console's upload. See scope prd 3.1.9 — the ceiling is checked against, not forced, and an image that still exceeds it is refused rather than stored._
- [x] **1.4.5** The console refuses a file that is not JPEG, PNG or WebP, naming the reason on screen, without asking for a grant. — verified by `packages/web/tests/integration/series-management-screen.test.ts`
- [x] **1.4.6** An admin choosing an image on a series row sees that row carry the cover afterwards, without reloading the page. — verified by `packages/web/tests/integration/series-management-screen.test.ts`
- [x] **1.4.7** Choosing a second image on the same row replaces what that row shows. — verified by `packages/web/tests/integration/series-management-screen.test.ts`
- [x] **1.4.8** Choosing an image on one row leaves every other row's cover unchanged. — verified by `packages/web/tests/integration/series-management-screen.test.ts`
- [x] **1.4.9** The console row's cover carries no alternative text, because the series title is rendered beside it. — verified by `packages/web/tests/integration/series-management-screen.test.ts`

**Assumptions**

- **Choosing a file is the whole gesture: no staging, no preview, no second press.** — major, user-facing: picking an image encodes it, uploads it and finalises it, and the row then shows what the API says the cover is. A confirm step would be a form with one field in it, and there is nothing to confirm against — the crop each surface applies is not decided here.
- **The re-encode always produces WebP, at quality 0.82, whatever went in.** — major, hard to change later: it is what is stored, and there is no original to re-derive from. 0.82 holds up behind a title at full width, and it is a *fixed* quality: the encoder does not re-encode at a lower one to fit under the ceiling. That was the choice the operator settled by raising the ceiling instead (scope prd 3.1.9).
- **`fitWithin` is exported as a pure function separate from the canvas work.** — major, produces code later steps will not anticipate: it is the only part of the encoder a Node test can reach, and it is the part carrying the decision rather than the plumbing.
- **The visible control is a `<label>` and the real `<input type="file">` is visually hidden rather than `display: none`.** — minor. Hiding it outright takes it out of the accessibility tree and out of reach of a keyboard.
- **The input's value is cleared after every choice.** — minor. Without it, choosing the same file twice fires no change event and the second upload silently never happens.
- **The list is re-read after a cover lands rather than the row being patched in place.** — minor. The cover a row shows is a signed URL the API minted; a client inventing one would be a second answer to a question only the API can answer.
- **`decodeImageBitmap` refusing a file is what catches an image that is not really an image.** — minor. The declared content type is checked first and cannot tell; a `.png` full of text fails the decode and surfaces as the row's refusal line.

**Edge cases**

- A browser with no WebP encoder gets "this browser encoded no image" on the row and no cover is set. Every browser this product targets has one; a very old one would simply be unable to set covers.
- A file that claims an accepted content type but is not decodable surfaces as a generic failure line on the row, not as "that file is not really an image".
- An animated GIF or a multi-frame WebP is flattened to its first frame without saying so. GIF is refused outright; an animated WebP would upload as a still.
- Colour profiles and EXIF orientation are whatever the canvas does with them. A photo carrying a rotation flag may be stored rotated, and nothing offers a way to correct it.
- A very large source — beyond roughly 100 megapixels on some browsers — fails the decode with the generic failure line rather than a message about size, because the ceiling this scope states is in bytes rather than pixels.
- **An image of unusually high visual entropy can re-encode to over the 4 MB ceiling and be refused, even though the admin chose a legal file and the encoder did its job.** The row reads "That image is N MB; the limit is 4 MB", which is true but reads as the product arguing with itself. The admin's only route is to choose a different image. This is scope prd 3.1.9 as a person experiences it, and it is accepted rather than solved — no fixed ceiling closes it.
- Navigating away mid-upload leaves the object in the bucket unfinalised, and the series keeps the cover it had. Nothing resumes it and nothing reports it.
- The row's busy state is per row, so two covers can be uploaded at once on different rows; the list re-read after each one is last-write-wins over what is displayed, not over what is stored.

**Manual steps**

- Look at `/admin/series` in a browser and set a cover on a real series. The suite proves what lands in the bucket and what the row renders; it does not judge whether the 4.5 × 3 rem crop reads well against `pages/series-listing.png` at the sizes real covers come in.

---

## 2. Where the cover appears

**Delivers:** the four member surfaces the design references draw a cover on stop being coverless.
**Feature:** scope prd 3.2
**Builds on:** `artworkUrl` from 1.3 — a signed URL or `null` on the payload, minted per response — and the no-cover rendering each of these surfaces already has, which scope tdd 1.8 keeps rather than replaces.

### 2.1 — The series listing thumbnail

**Delivers:** each row of the member series listing carries its series' cover.
**References:** scope prd 3.2.1, 4.3; scope tdd 1.4, 1.8; design-references/pages/series-listing.png; design-references/style-guide.md
**Touches:** `packages/web/src/app/(member)/series/series-listing.tsx` (the comment that currently says the thumbnail is dropped), `packages/web/src/app/(member)/screens.module.css`, `packages/web/tests/integration/series-screen.test.ts`
**Out of scope:** the no-cover row — that is 2.5.

**Acceptance criteria**

- [x] **2.1.1** A series with a cover renders it as the thumbnail at the left of its listing row. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [x] **2.1.2** The thumbnail is cropped to its frame from the centre rather than stretched to fill it. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [x] **2.1.3** The thumbnail carries no alternative text, because the series title is rendered beside it. — verified by `packages/web/tests/integration/series-screen.test.ts`

**Assumptions**

- **The frame is a fixed 7.5 rem × 5 rem landscape tile at `--radius-sm`, not a box the image's own proportions decide.** — major, user-facing: it is what a column of rows lines up on, and it is the size the next three surfaces will be read against. `pages/series-listing.png` draws the thumbnail at roughly three tenths of the row's width in a 3:2 frame, and 7.5 rem × 5 rem is that at the widths this listing is read at. Fixed rather than fluid because a row whose height follows its cover would make the listing ripple as covers load.
- **The thumbnail is the console's rendering at a different size, not a shared component.** — minor. Two `<img>` tags and two class rules, in two stylesheets that share no other rule; extracting one would couple a member screen to an admin one for four lines of CSS.
- **The crop is asserted through the computed `object-fit` and `object-position` and the rendered box, not through pixels.** — minor. The seeded cover is a synthesised container rather than a decodable picture, so what the suite can state is that the frame crops from its centre rather than stretching; that the stored bytes are a real image is scope plan 1.2's property, proved against the real store.
- **The listing's old "no image anywhere in this list" assertion narrows to the row that has no cover rather than being deleted.** — minor. Covers exist now, so the blanket claim is false; the claim worth keeping is that a coverless row still renders no frame, and scope plan 2.5 is where that becomes a claim across every surface at once.

**Edge cases**

- A cover whose signed URL has expired, or that points at a missing object, renders as a broken image frame in the tile rather than as no tile — the row has already decided to draw one by the time the browser finds out. This is scope plan 1.3's third edge case reaching a member surface for the first time.
- Nothing is drawn in the frame while the image is in flight: the tile is the raised surface colour until the bytes arrive, so a slow connection shows a column of empty rectangles rather than a placeholder or a spinner.
- The thumbnail keeps its full width at every viewport, so on a narrow phone a long series title has proportionally less room and wraps sooner than it did without a cover. No horizontal overflow at 390 px — the suite asserts that — but the balance the reference draws is a desktop balance.
- An extremely tall or wide cover is centre-cropped hard: a portrait image loses most of its top and bottom in a 3:2 frame, and nothing on the console previews what a row will keep. The admin finds out by looking at the listing.
- A cover and no cover sit in the same list at different row heights — a coverless row is as tall as its text, a covered one is at least the tile. The listing is deliberately not padded to one height, because reserving the tile's height on a coverless row is the empty box scope prd 3.2.6 rules out.

**Manual steps**

- Look at `/series` in a browser with real covers on some series and none on others. The suite proves the frame, the crop and the absence of alternative text; it does not judge whether the 7.5 × 5 rem tile reads against `pages/series-listing.png` at the sizes real covers come in, or whether the mixed-height column looks deliberate.

### 2.2 — The series page hero

**Delivers:** the flat band at the top of a series page becomes that series' cover.
**References:** scope prd 3.2.2; scope tdd 1.4, 1.8; design-references/pages/series-inner.png; design-references/style-guide.md
**Touches:** `packages/web/src/app/(member)/series/[id]/series-view.tsx` (the `hero` block and the comment that currently says the band is flat), `packages/web/src/app/(member)/screens.module.css`, `packages/web/tests/integration/series-screen.test.ts`
**Out of scope:** the no-cover band — that is 2.5.

**Acceptance criteria**

- [ ] **2.2.1** A series with a cover renders it as the hero band at the top of its page. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.2.2** The band's back control is still clickable with the artwork behind it, and leaves the page. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.2.3** The artwork is cropped to the band from the centre rather than stretched to its proportions. — verified by `packages/web/tests/integration/series-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

### 2.3 — The recording page hero

**Delivers:** a recording page carries the cover of the series it belongs to.
**References:** scope prd 3.2.3; scope tdd 1.4, 1.8; design-references/pages/chapter.png
**Touches:** `packages/shared/src/recordings.ts` (`RecordingSeriesRef`), `packages/db/src/visibility.ts` (`VisibleRecordingRow`, `listVisibleRecordings`, `findVisibleRecording`), `packages/web/src/server/recordings/service.ts` (`describeRecording`), `packages/web/src/app/(member)/recordings/[id]/recording-view.tsx` (the `hero` block), `packages/web/src/app/(member)/screens.module.css`, `packages/web/tests/integration/member-library.test.ts`, `packages/web/tests/integration/series-screen.test.ts`
**Out of scope:** the recording that belongs to no series — that is 2.5.

**Acceptance criteria**

- [ ] **2.3.1** A recording payload carries its series' `artworkUrl` on the `series` field, and still no object key anywhere. — verified by `packages/web/tests/integration/member-library.test.ts`
- [ ] **2.3.2** A recording in a series with a cover renders that cover as its hero band. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.3.3** Two recordings in the same series render the same cover, because the cover is the series' and not the recording's. — verified by `packages/web/tests/integration/series-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

### 2.4 — The transport tile

**Delivers:** the docked transport's left slot shows the cover of what is playing, on every screen it travels to.
**References:** scope prd 3.2.4, 4.3; scope tdd 1.4, 1.8; design-references/bottom-navigation/default.png
**Touches:** `packages/web/src/app/(member)/player-context.tsx` (`LoadedRecording`, `open`), `packages/web/src/app/(member)/recordings/[id]/recording-view.tsx` (the one `open(...)` call site), `packages/web/src/app/(member)/transport-bar.tsx`, `packages/web/src/app/(member)/transport.module.css` (the comment that currently says the slot carries a title because artwork is deferred), `packages/web/tests/integration/player-screen.test.ts`
**Out of scope:** the recording in no series — that is 2.5.

**Acceptance criteria**

- [ ] **2.4.1** Playing a recording in a series with a cover shows that cover in the transport's left slot. — verified by `packages/web/tests/integration/player-screen.test.ts`
- [ ] **2.4.2** The tile is labelled with the series it belongs to, because it stands alone rather than beside a title. — verified by `packages/web/tests/integration/player-screen.test.ts`
- [ ] **2.4.3** Navigating from the recording page to the library leaves the same cover in the slot. — verified by `packages/web/tests/integration/player-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

### 2.5 — No cover, everywhere

**Delivers:** every surface this step opened holds its layout when there is nothing to show, and shows nothing rather than an empty frame.
**References:** scope prd 3.2.6; scope tdd 1.8; design-references/pages/series-listing.png; design-references/pages/series-inner.png; design-references/pages/chapter.png; design-references/bottom-navigation/default.png
**Touches:** `packages/web/src/app/(member)/series/series-listing.tsx`, `packages/web/src/app/(member)/series/[id]/series-view.tsx`, `packages/web/src/app/(member)/recordings/[id]/recording-view.tsx`, `packages/web/src/app/(member)/transport-bar.tsx`, `packages/web/src/app/admin/series/series-panel.tsx`, `packages/web/tests/integration/series-screen.test.ts`, `packages/web/tests/integration/player-screen.test.ts`, `packages/web/tests/integration/series-management-screen.test.ts`
**Out of scope:** the now-playing view's own empty case — it does not exist yet, and it is 3.2.

**Acceptance criteria**

- [ ] **2.5.1** A series with no cover renders its listing row with no image element in the DOM at all. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.5.2** A series with no cover renders its page with the flat band and no image element in it. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.5.3** A recording that belongs to no series renders its page with the flat band and no image element in it. — verified by `packages/web/tests/integration/series-screen.test.ts`
- [ ] **2.5.4** Playing a recording that belongs to no series leaves the transport's left slot carrying the title and no image element. — verified by `packages/web/tests/integration/player-screen.test.ts`
- [ ] **2.5.5** A series with no cover renders its console row with no image element in it. — verified by `packages/web/tests/integration/series-management-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

---

## 3. The now-playing view

**Delivers:** the expanded playback surface `pages/player.png` draws — a full cover and the teaching's scripture — opened from the docked transport and closed back to where the member was.
**Feature:** scope prd 3.3
**Builds on:** the member layout that keeps the transport and its `<audio>` element mounted across client-side navigation, and `artworkUrl` travelling on the loaded recording from 2.4 — so the view reads what is playing rather than fetching it.

### 3.1 — The route, opened and closed

**Delivers:** a route under the member layout that the transport opens and that closes back, with playback untouched either way.
**References:** scope prd 3.3.1, 3.3.4; scope tdd 1.6, 1.7
**Touches:** new `packages/web/src/app/(member)/now-playing/page.tsx`, new `packages/web/src/app/(member)/now-playing/now-playing-view.tsx`, new `packages/web/src/app/(member)/now-playing/now-playing.module.css`, `packages/web/src/app/(member)/transport-bar.tsx`, `packages/web/src/app/(member)/transport.module.css`, `packages/shared/src/playback.ts` (the page path constant), `packages/web/src/app/(member)/layout.tsx` (read, to confirm the mount point), new `packages/web/tests/integration/now-playing-screen.test.ts`, `packages/web/tests/integration/route-sweep.test.ts`
**Out of scope:** what the view contains — that is 3.2 and 3.3. This substep's view is the frame and the two transitions.

**Acceptance criteria**

- [ ] **3.1.1** The docked transport offers a control that opens the now-playing view. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.1.2** The view closes back to the screen the member opened it from. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.1.3** Opening the view leaves a playing teaching playing. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.1.4** Closing the view leaves a playing teaching playing. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.1.5** The `<audio>` element is the same element after opening the view as before it, so no fresh playback grant is requested. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.1.6** The view renders no play, pause, seek or speed control of its own — the docked transport is still the only one on screen. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

### 3.2 — The square cover

**Delivers:** the large square `pages/player.png` draws, filled from the playing teaching's series.
**References:** scope prd 3.3.2, 3.3.5, 4.3; scope tdd 1.6; design-references/pages/player.png; design-references/style-guide.md
**Touches:** `packages/web/src/app/(member)/now-playing/now-playing-view.tsx`, `packages/web/src/app/(member)/now-playing/now-playing.module.css`, `packages/web/src/app/(member)/player-context.tsx` (read — `LoadedRecording` already carries the URL from 2.4), `packages/web/tests/integration/now-playing-screen.test.ts`
**Out of scope:** the scripture beneath it — that is 3.3.

**Acceptance criteria**

- [ ] **3.2.1** The view renders the playing teaching's series cover as a square. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.2.2** The square is cropped from the centre rather than stretched to a square from a non-square source. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.2.3** The square is labelled with the series it belongs to, because it stands alone. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.2.4** A playing recording that belongs to no series renders the view with no image element in it. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._

### 3.3 — The scripture beneath it

**Delivers:** the playing teaching's published references, with verse text, under the cover.
**References:** scope prd 3.3.3, 3.3.6; scope tdd 1.7; design-references/pages/player.png
**Touches:** `packages/web/src/app/(member)/now-playing/now-playing-view.tsx`, `packages/web/src/app/(member)/recordings/[id]/scripture-panel.tsx`, `packages/web/src/app/(member)/recordings/[id]/scripture.module.css`, `packages/web/src/app/api/v1/recordings/[id]/scripture/route.ts` (read — the existing read path, unchanged), `packages/web/tests/integration/now-playing-screen.test.ts`
**Out of scope:** any other tab or panel from the recording page — notes, transcript, summary and mind map stay off this view.

**Acceptance criteria**

- [ ] **3.3.1** The view lists the playing teaching's published scripture references with their full verse text. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.3.2** The references appear in the order the API answered with, not re-sorted by the view. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.3.3** A playing teaching with no published references renders the list stated as empty rather than a blank area. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`
- [ ] **3.3.4** A reference that is drafted and not published does not appear on the view for a member. — verified by `packages/web/tests/integration/now-playing-screen.test.ts`

**Assumptions**
_Written by the build phase — leave empty here._

**Edge cases**
_Written by the build phase — leave empty here._

**Manual steps**
_Written by the build phase — leave empty here._
