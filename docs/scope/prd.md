# Teaching Hub — Scope: series artwork

## 1. What's in

- **Series cover artwork** — an admin puts an image on a series, replaces it, and it is stored and served like every other piece of media in the product. (project prd 3.3.3, 3.19.5)
- **Where the cover appears** — the four surfaces the design references draw it on: the series listing, the series page, the recording page, and the docked transport. (project prd 3.3.3)
- **The now-playing view** — the expanded playback surface `pages/player.png` draws, carrying the cover of what is playing and that teaching's scripture. (project prd 3.2.15, 3.7.5)

## 2. What this scope delivers

A series stops being a title on a dark band. An admin uploads a cover on the series console, the browser reduces it to one bounded image before a byte leaves the device, and it lands in the same private bucket the audio lives in — read only through a short-lived signed grant, never from a public address. From then on the cover is the series' face everywhere the design references draw one: a thumbnail on the series listing, a hero band on the series page, the same band on every recording page in that series, and a small tile in the docked transport that says what is playing without reading a word. Tapping that tile opens the now-playing view — a full square cover with the teaching's published scripture beneath it — and closing it puts the member back where they were with the audio never having stopped.

A series with no cover is still an ordinary series. Every one of those surfaces renders without artwork rather than showing an empty box, which is what it does today.

- **As an admin, I can** upload a cover on any series from the console, see it on the row immediately, and replace it with a different image whenever I want.
- **As a member, I can** recognise a series by its cover in the listing, on its own page, on every recording inside it, and in the transport while it plays.
- **As a member, I can** open the playing teaching into a full view showing its cover and its scripture references, and close it again without the audio breaking.

## 3. Features

### 3.1 Uploading a cover

_Refines: project prd 3.3.3_

**Functional requirements**

- **3.1.1** An admin sets a series' cover from the series console (project prd 3.19.5), by choosing an image file on the series' row. JPEG, PNG and WebP are accepted; anything else is refused on the screen with the reason, before anything is sent. (refines project prd 3.3.3)
- **3.1.2** The browser re-encodes the chosen image before sending it: **aspect ratio is preserved**, the longest edge is reduced to at most 2000 px if it exceeds that, and the result is one WebP. What is stored is that re-encoded image and not the file the admin picked — there is one object per series and no original beside it. (refines project prd 3.3.3)
- **3.1.3** The re-encoded bytes go straight from the browser to media storage under a short-lived, single-purpose upload grant bound to a server-minted key, rather than through the application — the same route the audio upload takes. (refines project prd 3.3.3; mirrors project prd 3.2.1)
- **3.1.4** The series records the cover only after the stored object has been checked server-side against the same size and type limits the screen stated, read from the store's own metadata rather than from anything the browser claimed. An upload that fails that check leaves the series' cover unchanged. (refines project prd 3.3.3; mirrors project prd 3.2.1)
- **3.1.5** Uploading a cover on a series that already has one writes a new object and repoints the series at it. The superseded object is left in the store, invisible and unreferenced. **There is no remove**: a series that has a cover always has one, and a wrong image is corrected by uploading a different one. (refines project prd 3.3.3)
- **3.1.6** Cover artwork is never publicly addressable. Every read is a short-lived signed URL minted after the authorisation check has already passed, exactly as audio is, and no response ever carries an object key. (refines project prd 6.6)
- **3.1.7** A series with no cover is an ordinary state rather than an error, and stays available: nothing in this scope requires a cover before a series can be created, filled, or published from.
- **3.1.8** Setting a cover is an admin action. Members cannot set one, and the refusal is made by the API rather than by the absence of a control.
- **3.1.9** The re-encoded image must be under **4 MB**, and that is a limit the upload is *checked against* rather than one the re-encode forces. Any ordinary cover at 2000 px lands far under it; an image of unusually high visual entropy can exceed it even after re-encoding, and is refused with the reason on screen rather than stored. No fixed ceiling can close that gap, so the refusal is the answer to it rather than a larger number. (refines project prd 3.3.3)

### 3.2 Where the cover appears

_Refines: project prd 3.3.3_

**Functional requirements**

- **3.2.1** The series listing shows each series' cover as a thumbnail at the left of its row, as `design-references/pages/series-listing.png` draws it. The cover is cropped to the row's frame from the centre; it is never stretched. (refines project prd 3.3.3)
- **3.2.2** The series page shows the cover as the hero band at the top, as `design-references/pages/series-inner.png` draws it — cropped to the band and fading into the page beneath it, with the back control over it. This replaces the flat band the page renders today. (refines project prd 3.3.3)
- **3.2.3** A recording page shows the cover of the series that recording belongs to, in the same hero band and by the same treatment, as `design-references/pages/chapter.png` draws it. (refines project prd 3.3.3, 3.3.10)
- **3.2.4** The docked transport shows the cover of what is playing in the thumbnail slot at its left, as `design-references/bottom-navigation/default.png` draws it. (refines project prd 3.3.3, 3.2.14)
- **3.2.5** The series console shows each series' cover on its row too, so an admin reads what they uploaded on the screen they uploaded it from rather than by opening the member surface. (refines project prd 3.19.5)
- **3.2.6** Every surface in 3.2.1–3.2.5 renders **without** artwork when there is none — the listing row drops the thumbnail rather than reserving an empty box, the transport keeps the title in its slot, and the two hero bands stay a flat band holding the back control. A recording that belongs to no series (project prd 3.3.9) is that case on 3.2.3 and 3.2.4, and it is ordinary rather than degraded. (refines project prd 3.3.9)
- **3.2.7** The two hero bands are full-bleed: borderless, square-cornered, and running to the edges of the reading column as `design-references/pages/series-inner.png` and `design-references/pages/chapter.png` draw them. With a cover the band is 3:1 and fades into the page at its foot; with none it is a flat strip at the height it had before this scope. Added during the build of scope plan 2.2–2.3, when the previous bordered 96 px card was found to crop a cover to a ~7:1 slice of its own middle. (refines project prd 3.3.3)

### 3.3 The now-playing view

_Refines: project prd 3.2.15_

**Functional requirements**

- **3.3.1** The docked transport opens an expanded now-playing view, and the view closes back to wherever the member was. (refines project prd 3.2.15)
- **3.3.2** The view shows the cover of the playing teaching's series as a large square, cropped from the centre of whatever was uploaded, as `design-references/pages/player.png` draws it. (refines project prd 3.2.15, 3.3.3)
- **3.3.3** Beneath the cover the view lists the playing teaching's published scripture references with their full verse text, as `design-references/pages/player.png` draws them and by the same rules the recording page already reads them under (project prd 3.7.4, 3.7.5, 3.7.9). (refines project prd 3.2.15)
- **3.3.4** Opening the view and closing it never interrupt playback, never restart it and never lose position. The view holds no transport state of its own — it reads the one playback session the docked transport already owns, and every control that changes playback stays on the transport. (refines project prd 3.2.15, 3.2.14)
- **3.3.5** A playing recording that belongs to no series has no cover to show, and the view renders without one rather than substituting a placeholder — the scripture list is what it carries in that case. (refines project prd 3.2.15, 3.3.9)
- **3.3.6** A playing teaching with no published scripture references shows an empty list stated as such, not a blank area. (refines project prd 3.2.15)

## 4. Non-functional requirements

| # | Category | Requirement | Refines |
| :- | :------- | :---------- | :------ |
| **4.1** | Performance | The bound at 3.1.2 is what makes the cover cheap everywhere: one object at 2000 px, cached by the browser, serves the thumbnail, both hero bands and the square. The 4 MB ceiling at 3.1.9 is the outer limit rather than the working size — an ordinary cover is a fraction of it. No surface waits on artwork to render its text: a cover that has not arrived yet leaves its frame empty and fills it when it lands, and never delays the row, the band or the transport. | project prd 6.2 |
| **4.2** | Security | Artwork lives in the same non-public bucket as the audio. Every read is a signed URL minted per response after the policy check; no payload carries an object key; no upload grant is minted before the request has been authorised and the declared type and size accepted. | project prd 6.6 |
| **4.3** | Accessibility | A cover sitting beside its own series title is decorative and carries no alternative text, so a screen reader is not told the title twice. A cover standing alone — the transport tile, the now-playing square — is labelled with the series it belongs to. | project prd 6.16 |

## 5. Out of scope

- **Podcast artwork constraints** — project prd 5.3.2 wants square and high-resolution covers, and this scope deliberately does not enforce either: any shape and any size pass, and the surfaces crop. A landscape cover uploaded here is not publishable to Spotify as it stands, and making it so is the distribution scope's problem, not this one's.
- **Podcast-shaped series metadata** — project prd 3.3.7. Nothing in the series row changes here except the artwork pointer.
- **Serving artwork to the podcast feed** — project prd 3.20.10 has series artwork populate the feed, and a feed Spotify fetches anonymously cannot use the expiring signed URL at 3.1.6. How the feed service reaches the object is that service's decision and it does not exist yet.
- **Server-side renditions** — no worker job, no image library, no second media pointer, no thumbnail derived from the original. One object serves every surface, by the bound at 3.1.2. Deriving sizes properly is a later change and a real one; it is not needed at tens of series.
- **Keeping the file the admin chose** — 3.1.2 stores the re-encoded image and nothing else. There is no original artwork to go back to, unlike audio, where project prd 3.4.9 requires exactly that.
- **Removing a cover** — 3.1.5 is replace-only. Returning a series to no cover is not offered, and the media store has no delete to build it on.
- **Recording-level artwork** — a recording shows its series' cover or none. project prd 4.2 has no artwork field and this scope does not add one.
- **AI-generated or automatically-sourced artwork** — every cover in this scope is a file a person chose.
- **Contributor uploads** — project prd 3.1's role table gives a Contributor series artwork, and the role does not exist in the policy yet. 3.1.8 is admin-only for that reason, and widening it is one line the day the role arrives.
- **Artwork offline and in downloads** — project prd 3.18 is untouched. A downloaded teaching played with no connectivity has no signed URL to fetch a cover with, and renders by 3.2.6.
- **Anything else on the now-playing view** — `pages/player.png` draws a cover and a scripture list, and 3.3 builds exactly those two. No notes, transcript, mind map or summary tab, and no transport controls duplicated onto it.
- **Series reorder and merge** — project prd 3.3.6 still has both deferred; this scope opens the series console and does not widen what it can do.
- **Videos on the series page** — project prd 3.3.8.

## 6. Assumptions

- **The re-encoding at 3.1.2 preserves the source aspect ratio rather than cropping to square.** — major, user-facing: what the admin sees on the surfaces is a crop of their own image rather than a squared version of it, and a landscape cover stays landscape in storage. Confirmed — the alternative was enforcing project prd 5.3.2's square shape at upload, and that was declined in favour of accepting any image.
- **No copy of the file the admin chose is kept.** — major, hard to change later: the re-encode happens before the upload grant is used, so the original bytes never reach the store and cannot be recovered to re-derive a different size from. Confirmed.
- **One cover per series, held as a single nullable pointer on the series row.** — major, hard to change later: every payload, every surface and any later rendition work binds to that shape. Confirmed.
- **The now-playing view is a route rendered inside the member layout, not a screen that replaces it.** — major, produces code later steps will not anticipate: it is the only arrangement in which the docked transport and its audio element stay mounted across the transition, which is what 3.3.4 requires. Not chosen so much as forced by 3.3.4.
- **The bound at 3.1.2 is a longest edge of 2000 px, WebP, at quality 0.82; the ceiling at 3.1.9 is 4 MB.** — major, user-facing: 2000 px is generous enough that a square upload survives at a resolution project prd 5.3.2 would accept and small enough to serve a thumbnail from. The ceiling was raised from 2 MB during the build, when a worst-case image — pseudo-random pixels, incompressible by any lossy codec — re-encoded to 3 MB and the API refused its own console's upload. Confirmed, in preference to re-encoding in a loop until it fits, to lowering the quality for every cover, and to dropping the byte guarantee. A large enough high-entropy image still exceeds 4 MB and is refused; that is accepted rather than solved.
- **Non-square frames crop from the centre and never letterbox or stretch.** — minor. One rule for the listing thumbnail, both hero bands and the square.
- **A superseded artwork object is left in the store.** — minor. The media store has no delete by design (project tdd 2.5); an unreferenced object is invisible, and this is the same accepted cost a refused audio upload already carries.
- **Artwork signed URLs expire after one hour, matching playback.** — minor. A member sitting on a page longer than that sees a cover fail to load on a hard refresh and not before; nothing about the page depends on it.
- **Setting a cover is one new capability rather than a widening of `series.update`.** — minor. Consistent with every other split in the policy, and it is what makes the Contributor widening one line.
