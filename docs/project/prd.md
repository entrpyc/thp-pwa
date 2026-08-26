# Teaching Hub — PRD

| Platform     | Progressive Web App — delivered on the web and listed in the Apple App Store and Google Play |
| :----------- | :-------------------------------------------------------------------------------------------- |
| Target Users | 100 members at launch → 1,000+                                                               |
| Scope        | Full scope — everything the product is meant to be                                           |

## 1. Executive summary

Teaching Hub is a private, member-exclusive platform for a teaching ministry group. It consolidates what is currently scattered across recordings, chat threads and personal notebooks into one place: audio teachings, transcripts, AI-generated summaries and video, interactive mind maps, scripture references, personal study tools and community engagement — all behind a single login.

The product solves a specific problem. A weekly teaching is heard once and then largely lost. Members who miss a session fall out of the thread of a series and have no route back in. Insight that surfaces during a teaching has nowhere to live. Teaching Hub attacks all three: every recording becomes a durable, searchable, cross-referenced artefact; members annotate teachings at the exact moment that matters to them; and members who have fallen behind are diagnosed and routed back to the specific teachings they missed.

The platform is simultaneously an internal content studio. Admins process raw recordings into a consistent sound profile, review AI-generated summaries and metadata before anything publishes, produce short-form video from the teaching library, and distribute externally — teaching series as podcasts on Spotify, video reels to social platforms — without leaving the app.

It is built as a Progressive Web App on a single codebase, reachable from any browser and also listed as an installable app in the Apple App Store and Google Play, so members find it where they already look for apps. It serves roughly 100 members at launch, with all content behind authentication and a weekly content cadence.

## 2. Product overview

| Product name          | Teaching Hub (working title)                                                                                                                              |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product type          | Progressive Web App, distributed via web and app stores                                                                                                   |
| Target audience       | Private ministry group members — 100 at launch, scaling to 1,000+                                                                                        |
| Access model          | Invite-only, login required, all content member-exclusive                                                                                                 |
| Content cadence       | Weekly teaching upload, plus back-catalogue processing                                                                                                    |
| External distribution | Spotify (teaching series as podcasts); Instagram, TikTok and LinkedIn (video reels)                                                                       |
| Core purpose          | A single hub where every teaching becomes durable, searchable and interconnected — and where members engage with it all week rather than hearing it once |

## 3. Features

### 🔨 3.1 Accounts & access

*Everything in the product sits behind this. The group is private by design: there is no public surface and no self-signup.*

| Role        | Description                                                 | Permissions                                                                                                                                                                                                                                                                                                                                   |
| :---------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin       | Owner and designated group members who control the platform | Everything a Contributor can do, plus: manage users and roles, review and publish AI summaries and metadata, moderate and pin timestamp notes, author and attach questionnaires, curate Flow Tracker question banks, configure audio processing settings, publish to external platforms, broadcast announcements, close or remove SOS signals |
| Contributor | Trusted members who help produce content                    | Upload recordings, manage series and series artwork, correct transcripts, generate AI videos, generate and edit AI summary drafts, generate and curate recording mind maps                                                                                                                                                                    |
| Member      | Authenticated group members                                 | Stream and download recordings, view published videos and summaries, generate personal mind maps, write timestamp notes, complete questionnaires, use the Flow Tracker, manage Highlights, raise and respond to SOS signals, search the library                                                                                               |

**Functional requirements**

- ✅ **3.1.1** Every user has an individual account identified by email address, with password authentication.
- ✅ **3.1.2** All content in the product requires an authenticated session. There is no anonymous or public view of any recording, video, summary, note or mind map — with the single exception of an explicitly shared mind map link (3.8.13).
- ✅ **3.1.3** New members join by admin invitation only. An admin enters an email address and assigns a role; the invitee receives an invitation and sets their own password to activate the account.
- ✅ **3.1.4** Invitations expire seven days after they are issued, and can be revoked or re-sent by an admin before they are accepted. Re-sending issues a fresh link and restarts the seven days rather than extending the original, so a forgotten invitation cannot be quietly kept alive.
- ✅ **3.1.5** An admin can change any user's role at any time. Permissions are enforced server-side on every request, never only in the interface.
- ✅ **3.1.6** A user can reset a forgotten password through an email-based flow without admin involvement. A reset link is valid for one hour and can be used once, and a second request inside a minute sends no second message. The response to a reset request is identical whether or not the address has an account, so the flow never discloses who is a member.
- ✅ **3.1.7** An admin can deactivate an account, and can reactivate it again later. Deactivation ends that account's sessions and cancels its outstanding reset links immediately rather than at their next expiry, so access stops at the moment the admin presses it. A deactivated account cannot sign in, but its authored content is retained.
- 📝 **3.1.8** A member can permanently delete their own account from within the app, without contacting an admin (5.2.6).
- 📝 **3.1.9** When an account is deleted, that user's private content is deleted with it: private notes (3.12.3), personal mind maps (3.8.5), questionnaire responses (3.13.8), Flow Tracker sessions (3.14.8) and Highlights (3.15).
- 📝 **3.1.10** Public content authored by a deleted account — public timestamp notes and their replies (3.12) — is retained and re-attributed to a removed-member placeholder, so existing threads stay coherent.
- ✅ **3.1.11** At least one Admin account must exist at all times. The system prevents removal or demotion of the last remaining admin.
- 🔨 **3.1.12** A user has a profile carrying their display name and optional avatar, shown as the author of their public notes (3.12) and SOS signals (3.16). A display name is up to 80 characters and is edited by its owner alone — an admin can end an account or change its role, and cannot rename the person behind it.
- ✅ **3.1.13** Signing in creates a server-side session, held by the client as an opaque token in an HTTP-only cookie that carries nothing about the user. A session lasts 30 days and is extended each time it is used; signing out revokes it, as does deactivation (3.1.7). Passwords are held only as hashes and are never recoverable, only reset (3.1.6).
- ✅ **3.1.14** The first Admin account is created by an operator command at deployment, from credentials held on the host rather than in the product. Re-running that command against an existing account never resets its password. Every account after the first arrives by invitation (3.1.3), which is what makes 3.1.11's guarantee true from the first minute the product runs.

### 🔨 3.2 Audio recordings & playback

*Every teaching exists first as a recording. Every other content type in this product — transcript, summary, mind map, video, cross-reference, search result — is derived from it.*

**Functional requirements**

- 🔨 **3.2.1** Admins and Contributors upload teaching recordings as audio files, accepting MP3, M4A, AAC, WAV and FLAC up to 200 MB per file — which covers a 90-minute teaching as a compressed export, and covers the lossless formats only for shorter recordings. The browser sends the bytes straight to media storage under a short-lived, single-purpose upload grant rather than through the application, and the recording is created only once the stored object has been checked against the same limits the screen stated before the file was chosen.
- ✅ **3.2.2** A recording is not visible to members until an admin explicitly publishes it (see 4.17.3).
- ✅ **3.2.3** Members stream any published recording.
- ✅ **3.2.4** Playback speed is adjustable across 0.5x, 0.75x, 1x, 1.25x, 1.5x and 2x. The chosen speed is a property of the account rather than of the session, so it persists across recordings and across every device that user signs in from.
- ✅ **3.2.5** Playback position is tracked per user per recording, and playback resumes from the last position on any device that user signs in from. The position is written while listening rather than only on leaving — at most once every ten seconds — and a position under five seconds is not stored at all, so opening a teaching and closing it again leaves no resume point behind.
- 📝 **3.2.6** Audio continues playing when the app is backgrounded or the device is locked, with transport controls available from the device lock screen and notification area.
- 📝 **3.2.7** Each user has a listening history recording which teachings they played, when, and how far through they got.
- 📝 **3.2.8** A recording is marked completed for a user once they reach the end, and completed teachings are visually distinguishable when browsing.
- ✅ **3.2.9** Members can scrub to any position in a recording, and can jump ten seconds backwards or forwards from the transport controls.
- 📝 **3.2.10** Admins and Contributors can replace the audio file on an existing recording. This re-runs processing (3.4) and transcription (3.5) while preserving the recording's notes, metadata and member progress.
- ✅ **3.2.11** An admin can unpublish a recording, removing it from member view without deleting it or its associated content.
- ✅ **3.2.12** A member's landing offers the teaching they were most recently listening to, showing how far they had got. Opening it restores that position and deliberately does not start playing — a member who tapped a card has not asked for sound.
- ✅ **3.2.13** Audio is streamed through a signed URL minted per request after an authorisation check and valid for an hour, never from a publicly addressable location. The player renews the grant before it expires, so a teaching longer than an hour plays through without interruption and without the client ever learning where the file lives.
- ✅ **3.2.14** The transport travels with the member: it is docked to every member screen, so playback continues while they move between the library, a series and a recording rather than stopping when they navigate.

### 🔨 3.3 Content organisation & series

**Functional requirements**

- ✅ **3.3.1** Recordings are organised primarily by date recorded, newest first — the order in which teachings are naturally consumed.
- ✅ **3.3.2** Recordings that belong together are grouped into a named series. A recording belongs to at most one series.
- 📝 **3.3.3** Each series has cover artwork uploaded by an admin, used as its visual identity throughout the app and as the podcast artwork for external distribution (5.3.2).
- ✅ **3.3.4** A series view lists every recording in that series chronologically — oldest first, the reverse of the date-ordered library at 3.3.1, because a study is read forwards — numbered by position, with the member's own progress (3.2.5) shown per recording.
- ✅ **3.3.5** Series carry their own title, description, date range and recording count (see 4.3). The date range and the count are computed from the recordings the reader is entitled to see rather than stored, so a member's count covers published recordings only while an admin's covers everything in the series.
- 🔨 **3.3.6** Admins and Contributors can create, rename, reorder and merge series, and can move a recording between series without losing its notes, metadata or member progress.
- 📝 **3.3.7** Series metadata is structured to satisfy podcast feed requirements from the point of creation, so a series can be published externally (3.20.2) without restructuring.
- 📝 **3.3.8** The series view surfaces the videos derived from that series' recordings alongside the recordings themselves (3.11.5.2).
- ✅ **3.3.9** A recording can exist without a series and still appear in date-ordered browsing. Most do, which is why belonging to no series is an ordinary state rather than an exception.
- ✅ **3.3.10** A recording that belongs to a series carries the series name wherever it is listed, and its page offers a route back to the series it came from. The date-ordered library is not regrouped by series — 3.3.1 stands, and the series name is a label on the row rather than a second ordering.

### 📝 3.4 Audio processing & quality

*The ministry records in inconsistent conditions. Members should not hear that inconsistency, and neither should podcast listeners.*

**Functional requirements**

- 📝 **3.4.1** Every uploaded recording is automatically processed before it becomes available for playback.
- 📝 **3.4.2** Processing reduces background noise present in the raw recording.
- 📝 **3.4.3** Processing enhances voice clarity and intelligibility.
- 📝 **3.4.4** Processing normalises loudness so volume is consistent from one teaching to the next, including across recordings captured months apart in different rooms.
- 📝 **3.4.5** A single named sound profile defines the processing applied to all recordings, so the library has one consistent character rather than per-recording tuning.
- 📝 **3.4.6** Admins can configure the sound profile's settings and preview the effect on a sample recording before saving changes.
- 📝 **3.4.7** Changing the sound profile does not retroactively alter already-processed recordings unless an admin explicitly re-processes them.
- 📝 **3.4.8** Admins can re-run processing on any individual recording or on a batch of recordings.
- 📝 **3.4.9** The original uploaded file is retained unmodified alongside the processed output, so processing can be re-run or reverted.
- 📝 **3.4.10** The processed output serves both in-app streaming and podcast distribution (5.3) without a separate export step.
- 📝 **3.4.11** If processing fails, the recording is flagged in the admin dashboard (3.19.4) rather than silently published or silently dropped.

### 🔨 3.5 Transcription

*The transcript is the hinge of the whole product. Summaries, mind maps, video scripts, cross-references and search all read from it.*

**Functional requirements**

- ✅ **3.5.1** Every recording is automatically transcribed as soon as its audio is ready — on upload completing while audio processing (3.4) does not yet exist, and on processing completing once that step sits ahead of transcription in the pipeline (3.21.1).
- ✅ **3.5.2** The transcript is segmented and timestamped, so any passage of text maps back to a position in the audio.
- ✅ **3.5.3** Members can read the transcript on the recording page, and the transcript view follows along with playback, highlighting the currently spoken segment. The view scrolls itself to keep the highlight in sight, and stops following the moment a member scrolls it themselves — offering a control to jump back to the current line rather than fighting them for the scroll position.
- ✅ **3.5.4** Selecting any point in the transcript seeks the audio to that position. Seeking from the transcript does not start playback: a member reading a paused teaching has not asked for sound.
- 🔨 **3.5.5** Admins and Contributors can correct transcript text, which is necessary for names, scripture citations and terminology specific to the ministry. A correction restates what the line says and where it starts and ends; the speaker index (3.5.9) is not something a correction can change. Every correction records who made it and when.
- 🔨 **3.5.6** Correcting a transcript offers to regenerate the artefacts derived from it — summary (3.6), mind map (3.8.1), scripture references (3.7.1), tags (4.17.1) and cross-references (3.9.1). The regeneration is offered and never performed unasked: declining it leaves the recording exactly as it was, and the offer covers only those artefacts that exist at the time.
- ✅ **3.5.7** The transcript records the language it was transcribed in. That language is currently pinned to English rather than detected, because the monolingual model is the more accurate one for a library that is entirely English. Detection returns as a requirement when non-English teachings do, and the field is already there to hold the answer.
- ✅ **3.5.8** If transcription fails, the recording is flagged for admin attention (3.19.4) rather than proceeding to downstream generation on bad input. If it succeeds but comes back below the accepted confidence threshold, the transcript is still written and still readable — so an admin can judge it and correct it (3.5.5) — but the pipeline halts there and is flagged, and nothing downstream is generated until an admin re-runs the step on words a human has accepted.
- ✅ **3.5.9** Each segment carries the transcription provider's anonymous speaker index where one was returned. It is an index and never a name: nothing in the product resolves it to a person, and the same voice is not the same index across two recordings. It is not editable, and a segment the provider attributes to nobody carries none.
- ✅ **3.5.10** While listening, a member can turn on captions and see the currently spoken line above the transport controls, on whichever screen they are on. Captions are off by default, and a silence between segments shows nothing rather than holding the previous line.

### 🔨 3.6 AI summaries

*One summary per recording, generated automatically but never published automatically.*

**Functional requirements**

- ✅ **3.6.1** One AI summary is generated per recording, triggered automatically when transcription (3.5.1) completes.
- ✅ **3.6.2** A summary is created in draft state. Members never see draft summaries.
- 📝 **3.6.3** Admins are notified in-app when a summary is ready for review (3.17.2).
- ✅ **3.6.4** Summaries are reviewed from a single Pending Reviews queue in the admin dashboard (3.19.2). A recording's row in the admin recordings list links straight to that recording's own pending items, so reviewing one teaching's drafts is one step away from the recording without a second review surface existing to drift from the first.
- ✅ **3.6.5** The review interface shows the summary in full alongside the recording title, date and word count.
- ✅ **3.6.6** Reviewing an admin has four actions available: approve, edit then approve, regenerate, or discard.
- ✅ **3.6.7** **Approve** publishes the summary immediately, making it visible to all members on the recording page.
- ✅ **3.6.8** **Edit then approve** opens an inline text editor. Plain text with line breaks is sufficient; no rich formatting is required.
- 🔨 **3.6.9** **Regenerate** discards the current draft and triggers a new generation pass. The admin can optionally supply a short prompt to steer the regeneration, and is notified when the new draft is ready. The steering prompt is a sentence rather than a second prompt and is capped accordingly; it is recorded alongside the draft it produced (4.17.5); and only one generation can be in flight for a recording at a time, so pressing twice cannot spend twice.
- ✅ **3.6.10** **Discard** permanently deletes the summary with no replacement. The recording remains publishable without one.
- ✅ **3.6.11** After publishing, an admin can still edit the summary text or unpublish it.
- ✅ **3.6.12** Unpublishing returns a summary to draft state — it is not deleted, and is no longer visible to members. The recording itself stays live, so a summary can be taken down without taking the teaching down with it.
- ✅ **3.6.13** The summary and the AI-suggested description (4.17.1) are two items of the same review queue, acted on independently. The summary carries a publication state of its own (3.6.12); the description has no second gate and becomes visible with the recording that carries it.
- ✅ **3.6.14** What the machine proposed is retained on a reviewed item after it is approved, edited or discarded, together with the model, the model version, the prompt version and any steering prompt used. A rejected draft leaves a record rather than nothing (4.17.5).

### 🔨 3.7 Scripture references

*Scripture connects each teaching to its biblical foundation, and connects teachings to each other through shared passages.*

**Functional requirements**

- 🔨 **3.7.1** Scripture references are automatically suggested from the transcript (3.5) and the recording's topics, produced as suggestions rather than published facts.
- ✅ **3.7.2** An admin reviews suggested references and can accept, edit, remove or manually add references before the recording publishes (4.17.2).
- ✅ **3.7.3** References are stored as structured citations — book, chapter, and verse or verse range — not as free text, so they can be compared across teachings.
- ✅ **3.7.4** Each reference displays the full verse text, readable without leaving the recording page.
- ✅ **3.7.5** Published references appear on the recording page alongside the summary (3.6.7).
- 📝 **3.7.6** Each displayed reference is a navigable link into the cross-referencing layer (3.9.4).
- 📝 **3.7.7** Members can find teachings by scripture citation through search (3.10.5).
- ✅ **3.7.8** A teaching in which no scripture is found still reaches the review queue holding an empty list, so an admin confirms that it cites none rather than the item never arriving. "Reviewed and found none" is a different fact from "nobody has looked yet", and the empty item is what makes 3.7.2's manual addition reachable for a teaching the automatic suggestion missed entirely.
- ✅ **3.7.9** Verse text is drawn from one free-to-use translation, named in deployment configuration rather than in code. The product holds one translation at a time and offers a member no choice between translations; the translation in use is named wherever its verse text is read, so nobody has to guess which words they are looking at.

### 📝 3.8 Mind maps

*Visual, interconnected representations of a teaching's concepts. Two distinct kinds: curated maps that belong to a recording, and personal maps that belong to a member.*

**Functional requirements**

*Recording mind maps*

- 📝 **3.8.1** A mind map is automatically generated for each recording from its transcript (3.5).
- 📝 **3.8.2** Admins and Contributors can edit and curate a recording's mind map — renaming nodes, removing them, and adjusting relationships — before it is visible to members.
- 📝 **3.8.3** The recording mind map is visual and interactive: members can expand, collapse and navigate between concept nodes.
- 📝 **3.8.4** Nodes that correspond to a moment in the teaching link to that timestamp in the recording.

*Personal mind maps*

- 📝 **3.8.5** Any member can generate a personal mind map from any recording or video, as a private study tool.
- 📝 **3.8.6** Personal maps are generated from the teaching transcript and its segments.
- 📝 **3.8.7** A member can generate multiple maps from the same source. Each generation creates a new entry; nothing is overwritten.
- 📝 **3.8.8** Each member has a "My Mind Maps" library, sorted by creation date, newest first.
- 📝 **3.8.9** Each library entry shows the source recording or video title, the date generated, and a thumbnail preview.
- 📝 **3.8.10** From the library a member can open a map full-screen or delete it.
- 📝 **3.8.11** Maps cannot be edited after creation. They are generated snapshots, not living documents.
- 📝 **3.8.12** Personal maps are private to their creator and are never surfaced automatically — a personal map does not appear under its source recording or in any community space.
- 📝 **3.8.13** A creator can explicitly publish a personal map to a shareable link. This is the only route by which anyone else can see it, it is set per map, and it is reversible at any time.

### 📝 3.9 Intelligent cross-referencing

*The layer that turns a list of recordings into an interconnected body of teaching. Nothing here is user-facing on its own — it powers the features that are.*

**Functional requirements**

- 📝 **3.9.1** The system automatically detects thematically similar segments across every teaching in the library, comparing at segment level rather than whole-recording level.
- 📝 **3.9.2** Related segments from other teachings are surfaced to the member while they listen, anchored to the part of the current teaching that triggered them.
- 📝 **3.9.3** Cross-references are drawn from transcripts (3.5), topics and tags (4.7), scripture references (3.7) and detected themes.
- 📝 **3.9.4** A scripture passage cited in one teaching surfaces every other teaching citing the same passage (3.7.6).
- 📝 **3.9.5** Selecting a related segment opens that recording at the relevant timestamp.
- 📝 **3.9.6** Cross-references are recomputed when a new recording joins the library, so new teachings link into existing ones and existing ones gain links to the new arrival.
- 📝 **3.9.7** Relationships between concepts are visually represented through mind maps (3.8).
- 📝 **3.9.8** This layer supplies the recommendations used by the Flow Tracker (3.14.6) and the relevance ranking used by search (3.10.2).

### 📝 3.10 Semantic search

*One search box over the whole library that understands what a member means, not just what they typed.*

**Functional requirements**

- 📝 **3.10.1** A single search entry point queries the entire library from anywhere in the app.
- 📝 **3.10.2** Search matches on meaning, not only literal keywords: a member searching for a concept finds teachings that discuss it without using their exact words.
- 📝 **3.10.3** Results return specific segments with timestamps, not only whole recordings, so a member lands on the moment rather than the hour.
- 📝 **3.10.4** Search covers recording titles and descriptions, transcripts (3.5), published summaries (3.6.7), topics and tags (4.7), scripture references (3.7) and series (3.3).
- 📝 **3.10.5** Members can search by scripture citation and find every teaching covering that passage.
- 📝 **3.10.6** Each result shows the matching passage in context, with its source recording, series and timestamp.
- 📝 **3.10.7** Selecting a result opens the recording at the matched timestamp.
- 📝 **3.10.8** Results can be filtered by series, date range, topic and scripture book.
- 📝 **3.10.9** Search respects visibility: a member's results include all published content plus their own private notes (3.12.3) and personal mind maps (3.8.5), and never include another member's private content or any unpublished draft.
- 📝 **3.10.10** Members can restrict a search to their own notes and mind maps, to find something they know they wrote.
- 📝 **3.10.11** Search returns a clear empty state that distinguishes "nothing in the library matches" from "search is unavailable".

### 📝 3.11 AI video generation

*Two purposes: in-house engagement, keeping members immersed in a teaching through the week, and external reach, producing social content for audiences who have never heard the ministry.*

#### 📝 3.11.1 Video types

- 📝 **3.11.1.1** Short-form reels of 30–60 seconds, generated from teaching transcripts.
- 📝 **3.11.1.2** Summary videos, longer-form visual recaps of a full teaching.
- 📝 **3.11.1.3** Only Admins and Contributors can generate videos.
- 📝 **3.11.1.4** Every generated and published video is viewable internally by all members, whether or not it is also published externally.
- 📝 **3.11.1.5** A video can additionally be published to external platforms for audiences outside the group (3.20.3).

#### 📝 3.11.2 Visual styles

- 📝 **3.11.2.1** Video style is applied from a selected preset, where each preset is a detailed description of a visual treatment.
- 📝 **3.11.2.2** Presets are curated and maintained by admins, and new presets can be added at any time.
- 📝 **3.11.2.3** Working from presets keeps output visually consistent across the catalogue rather than varying per generation.
- 📝 **3.11.2.4** Style is selected per video, not set globally.

#### 📝 3.11.3 Content sources

- 📝 **3.11.3.1** Teaching transcripts (3.5) processed through AI interpretation.
- 📝 **3.11.3.2** Manual scripts and prompts written by an admin.
- 📝 **3.11.3.3** Segments of a teaching selected manually by the creator.

#### 📝 3.11.4 Generation workflow

*The creator builds each video step by step through a guided flow.*

- 📝 **3.11.4.1** **Select source recording.** The creator opens the video creation flow from any recording page or from the admin dashboard (3.19.6). The recording's transcript loads automatically as the content source.
- 📝 **3.11.4.2** **Review segmented transcript.** The transcript is broken into logical segments by topic shift. Each segment is shown as a selectable block with its timestamp range and a text preview. The creator selects one or more segments, which combine into the video script, and can reorder them.
- 📝 **3.11.4.3** **Choose visual style.** The creator selects from the available presets (3.11.2).
- 📝 **3.11.4.4** **Choose audio layer.** The creator chooses per video between the original voiceover, clipped from the actual recording audio, and an AI voiceover reading the script in a clean voice. Background music options are available with either choice.
- 📝 **3.11.4.5** **Review and generate.** The creator sees a summary of their selections — segments, style, audio choice and estimated duration — then confirms and triggers generation. Generation runs in the background; the creator is not blocked from other work and is notified in-app when it completes (3.17.2).
- 📝 **3.11.4.6** **Review and publish.** The creator previews the generated video and either approves it, making it visible to all members, or discards it and starts over. There is no partial editing of generated output: it is approve or discard.
- 📝 **3.11.4.7** If generation fails, the creator is notified with the reason and the flow's selections are preserved so they can retry without rebuilding the video from scratch.

#### 📝 3.11.5 Catalogue & storage

- 📝 **3.11.5.1** All published videos are stored permanently as a growing catalogue.
- 📝 **3.11.5.2** Each video is classified under the series of its parent recording (3.3.8).
- 📝 **3.11.5.3** A separate view collects videos intended for external distribution.
- 📝 **3.11.5.4** Videos inherit topics and tags from their parent recording by default, and an admin can override them (4.8).
- 📝 **3.11.5.5** An admin can unpublish or delete a video from the catalogue.

### 🔨 3.12 Timestamp notes

*Notes replace generic comments as the primary engagement mechanism. A note is tied to a specific moment in a teaching, not to the teaching as a whole.*

**Functional requirements**

- ✅ **3.12.1** Members can write a note at any point in a recording, anchored automatically to the current playback position.
- ✅ **3.12.2** **Public notes** are visible to all members under the recording, at their respective timestamps.
- ✅ **3.12.3** **Private notes** are visible only to their author, for personal study and reflection.
- ✅ **3.12.4** The author selects public or private at the time of writing.
- ✅ **3.12.5** Notes are plain text with a 1,000 character limit.
- ✅ **3.12.6** Any public note can carry a reply thread.
- ✅ **3.12.7** Threads are one level deep: members reply to a note, but cannot reply to a reply.
- ✅ **3.12.8** Private notes have no threads — they are personal and non-collaborative.
- ✅ **3.12.9** Members can edit or delete their own notes at any time.
- ✅ **3.12.10** Admins can delete any public note or reply.
- ✅ **3.12.11** Public notes are displayed chronologically by timestamp on the recording page.
- ✅ **3.12.12** Notes are rendered as markers on the audio progress bar (3.2.9), so members can jump directly to noted moments.
- ✅ **3.12.13** Members can react to any public note with an emoji from a constrained picker of six reactions.
- ✅ **3.12.14** A member has one reaction per note, changeable by selecting a different one.
- ✅ **3.12.15** Admins can pin any number of public notes on a recording. Pinned notes appear above the main note list, each with a visual indicator.
- 📝 **3.12.16** The author of a public note is notified when someone replies to it (3.17.2).
- 📝 **3.12.17** Members can pin their own notes to Highlights (3.15.3).
- ✅ **3.12.18** Deleting a note that carries replies leaves a placeholder in its position, holding the moment it was written at, its marker on the progress bar (3.12.12) and the replies underneath it. One member deleting their own note does not delete the replies other members wrote to it. A note with no replies is removed outright, and a placeholder is never pinned (3.12.15).
- ✅ **3.12.19** A deleted note’s text is returned to nobody — its author and an admin included — and the placeholder says only that the note was removed, never who removed it. The record of who removed it is the audit log (3.12.10).
- ✅ **3.12.20** A member can clear their reaction to a note by selecting the one they have already chosen (3.12.14).

### 📝 3.13 Reflective questionnaires

*Questionnaires move members from passive listening into meditation, personal application and spiritual practice. They are contemplative tools, not assessments.*

**Functional requirements**

- 📝 **3.13.1** Each recording can have one admin-curated reflective questionnaire attached to it.
- 📝 **3.13.2** Questionnaires are created and managed by admins only.
- 📝 **3.13.3** Questions are written manually by the admin. There is no AI generation of questionnaire content.
- 📝 **3.13.4** Three question types are supported: open reflection, multiple choice, and scripture reference prompts.
- 📝 **3.13.5** A questionnaire appears on the recording page below the summary and is accessible to all members.
- 📝 **3.13.6** Members complete a questionnaire at their own pace, with no time limit and no enforced question order.
- 📝 **3.13.7** Members can save partial progress and return to finish later.
- 📝 **3.13.8** Responses are private to the member who wrote them.
- 📝 **3.13.9** Members can return and update their responses at any time.
- 📝 **3.13.10** Questionnaires are never graded or scored, and no correct answers exist.
- 📝 **3.13.11** Admins can edit a questionnaire after members have responded. Existing responses are preserved and remain attached to the questions they answered.
- 📝 **3.13.12** A recording without a questionnaire displays no questionnaire section at all.

### 📝 3.14 Flow tracker

*For the member who has lost the thread of a series. It identifies where they fell behind and gives them a route back in. It is a self-assessment and recommendation tool, never a test.*

**Functional requirements**

- 📝 **3.14.1** A member starts the Flow Tracker from their profile or from a series page.
- 📝 **3.14.2** The member selects the teaching from which they feel they lost the flow, setting the point of divergence.
- 📝 **3.14.3** The system assembles questions covering each teaching topic from the most recent teaching back to the selected starting point.
- 📝 **3.14.4** Questions are drawn from teaching content and from admin-curated question banks.
- 📝 **3.14.5** Questions are presented in reverse chronological order — from the latest teaching back to the point of divergence.
- 📝 **3.14.6** Where a response indicates a gap in understanding, the system surfaces the teachings and topics that address it, using the cross-referencing layer (3.9.8).
- 📝 **3.14.7** Each recommendation links directly to the relevant recording and to the timestamp where that topic is covered.
- 📝 **3.14.8** Flow Tracker responses are strictly private to the member. No result is visible to admins or to other members.
- 📝 **3.14.9** There is no score, grade or pass mark. The output is a reading list, not a result.
- 📝 **3.14.10** A member can run the Flow Tracker as often as they like, and can leave a session and resume it.
- 📝 **3.14.11** Admins curate the question banks that feed 3.14.4, per teaching or per topic, from the admin dashboard (3.19.7).

### 📝 3.15 Highlights playlist

*A personal, private library of the moments that mattered most to each member.*

**Functional requirements**

- 📝 **3.15.1** Any member can pin a full recording to their Highlights.
- 📝 **3.15.2** Any member can pin a specific topic or segment of a recording, capturing the moment rather than the whole teaching.
- 📝 **3.15.3** Members can pin timestamp notes they have written (3.12.17).
- 📝 **3.15.4** Pinning is available from the recording page, the series view, and while listening.
- 📝 **3.15.5** Highlights are accessible as a dedicated section from the member's profile.
- 📝 **3.15.6** Highlights display as a playlist, each entry showing its title, series, date pinned, and either a brief description or the note text if a note was pinned.
- 📝 **3.15.7** Playing an entry from Highlights opens the recording at the relevant timestamp.
- 📝 **3.15.8** Members can remove any entry at any time.
- 📝 **3.15.9** Highlights are private to the member and are not visible to other members or to admins.

### 📝 3.16 SOS signal

*A prayer emergency channel. Any member can reach the whole group, and the group can respond.*

| Colour    | When to use                                           |
| :-------- | :---------------------------------------------------- |
| 🔴 Red    | Immediate crisis — acute danger or medical emergency |
| 🟠 Orange | Serious situation needing prompt prayer               |
| 🟡 Yellow | Difficult but not urgent — an ongoing struggle       |
| 🟢 Green  | General prayer request, no urgency                    |

**Functional requirements**

- 📝 **3.16.1** Any member can raise an SOS signal, selecting one of the four urgency colours above.
- 📝 **3.16.2** A signal carries a short free-text description of what prayer is needed.
- 📝 **3.16.3** Raising a signal broadcasts it to the entire group through the notification system (3.17.2), at every urgency level.
- 📝 **3.16.4** Signals appear in a dedicated SOS section listing all open signals, most urgent and most recent first.
- 📝 **3.16.5** Members can acknowledge a signal with a single "praying" response, and the signal shows how many members have done so.
- 📝 **3.16.6** Members can reply to a signal with a short message of encouragement or scripture.
- 📝 **3.16.7** The member who raised a signal is notified when someone replies to it.
- 📝 **3.16.8** The author can close their own signal when the situation is resolved, optionally adding a closing note.
- 📝 **3.16.9** An admin can close any signal.
- 📝 **3.16.10** Closed signals move out of the open list into a resolved view, where they remain visible to the group rather than being deleted.
- 📝 **3.16.11** An admin can remove a signal entirely if it is inappropriate or raised in error.
- 📝 **3.16.12** A member can have a limited number of open signals at once, so the channel keeps its urgency.
- 📝 **3.16.13** Signals and their replies are visible to all members. There is no private or anonymous SOS.

### 📝 3.17 Notifications

*One event model, delivered through two channels. Both channels reflect the same events.*

**Delivery channels**

- 📝 **3.17.1** Push notifications reach the member at device level, working when the app is backgrounded or closed, on the web PWA and in the store-distributed app alike (5.2.5).
- 📝 **3.17.2** An in-app notification centre, reachable from a bell in the main navigation, lists the same events for any signed-in member.
- 📝 **3.17.3** The bell shows an unread count, and opening a notification takes the member to the content that triggered it.

**Events**

| #       | Event                     | Trigger                                                 | Who receives it              |
| :------ | :------------------------ | :------------------------------------------------------ | :--------------------------- |
| 3.17.4  | New recording published   | An admin publishes a recording (3.2.2)                  | All members                  |
| 3.17.5  | New video published       | A video is approved and published (3.11.4.6)            | All members                  |
| 3.17.6  | Note reply                | Another member replies to your public note (3.12.16)    | Note author                  |
| 3.17.7  | SOS raised                | A member raises a signal (3.16.3)                       | All members                  |
| 3.17.8  | SOS reply                 | A member replies to your signal (3.16.7)                | Signal author                |
| 3.17.9  | Admin announcement        | An admin sends a manual broadcast                       | All members                  |
| 3.17.10 | Summary ready for review  | An AI summary reaches draft state (3.6.3)               | Admins                       |
| 3.17.11 | Video generation complete | Generation finishes or fails (3.11.4.5)                 | The creator who triggered it |
| 3.17.12 | Processing failure        | Audio processing or transcription fails (3.4.11, 3.5.8) | Admins                       |

**Preferences**

- 📝 **3.17.13** Members can turn push delivery on or off per event category, while the in-app centre continues to receive everything.
- 📝 **3.17.14** Admin announcements and SOS signals can be muted by a member like any other category — the group does not override individual choice.
- 📝 **3.17.15** Admins compose and send announcements from the admin dashboard (3.19.8).

### 📝 3.18 Offline support & downloads

*Members listen on commutes, in transit and in places with no signal. Offline is a core mode of use, not a degraded fallback.*

**What is available offline**

- 📝 **3.18.1** Downloaded recordings play offline with full speed control (3.2.4) and resume position (3.2.5).
- 📝 **3.18.2** Mind maps are viewable offline (3.8).
- 📝 **3.18.3** Published summaries (3.6) and scripture references (3.7) attached to downloaded recordings are available offline.
- 📝 **3.18.4** Timestamp notes on downloaded recordings are readable offline.

**Downloading**

- 📝 **3.18.5** Every recording page carries a download control for that single recording.
- 📝 **3.18.6** Every series page carries a "Download all" control that queues the entire series in one action.
- 📝 **3.18.7** Downloads are queued and run in the background while the member continues using the app.
- 📝 **3.18.8** A progress indicator shows active downloads, both per item and for the overall queue.
- 📝 **3.18.9** Already-downloaded items carry a visual indicator wherever they appear.

**Managing downloads**

- 📝 **3.18.10** A dedicated Downloads section in the member's profile lists all downloaded content, each entry showing title, series, file size and date downloaded.
- 📝 **3.18.11** Members can delete individual downloads to reclaim device storage, and can see total storage in use.
- 📝 **3.18.12** When a recording is unpublished (3.2.11) or deleted, existing downloads of it are removed from members' devices on next sync.

**Offline behaviour**

- 📝 **3.18.13** When offline the app presents only content that is actually available, rather than showing entries that fail on selection.
- 📝 **3.18.14** Playback progress and resume position are stored locally and synced to the server when connectivity returns.
- 📝 **3.18.15** Notes written offline are stored locally and sync when connectivity returns (3.12).
- 📝 **3.18.16** The app clearly indicates when it is operating offline and when a sync is pending.
- 📝 **3.18.17** On the browser-delivered PWA, where downloaded media lives in storage the browser may cap or reclaim, a download that would not fit is refused before it starts rather than failing partway. The app reads what the device has free, and a "Download all" (3.18.6) larger than that says what the series needs and what is available, and offers the most recent recordings that do fit. Store builds hold downloads on a filesystem the OS does not evict (5.2.1) and are not subject to this.

### 🔨 3.19 Admin dashboard

*The single surface from which the platform is run. Every admin and contributor capability is reachable from here.*

**Functional requirements**

- 🔨 **3.19.1** A dashboard available to Admins and Contributors, with each user seeing only the capabilities their role permits (3.1).
- 🔨 **3.19.2** A Pending Reviews queue collecting everything awaiting admin action: draft summaries (3.6.4), suggested metadata and scripture references (4.17.2), and back-catalogue items (3.21.3.4).
- ✅ **3.19.3** Recording upload and the metadata review form (4.17.2), including the publish action (3.2.2).
- ✅ **3.19.4** A processing status view showing which recordings are in processing, transcription or generation, which have failed and why each failure happened, with a control to re-run any single step (3.21.2.4). Every run of a step is kept rather than overwritten, so an admin reads the latest attempt and can still see that it was the third. The view refreshes itself while work is in flight and stops asking once nothing is running.
- 🔨 **3.19.5** Series management (3.3.6), including artwork upload.
- 📝 **3.19.6** Video creation entry point and generation status (3.11.4.1).
- 📝 **3.19.7** Questionnaire authoring (3.13.2) and Flow Tracker question bank curation (3.14.11).
- 📝 **3.19.8** Announcement composition and broadcast (3.17.15).
- ✅ **3.19.9** User management: invitations, role assignment, deactivation and the member list (3.1.3–3.1.7).
- 📝 **3.19.10** Audio processing settings and sound profile configuration (3.4.6).
- 📝 **3.19.11** External publishing status and queues (3.20.6).
- 📝 **3.19.12** SOS oversight: view open signals, close them, remove them (3.16.9, 3.16.11).
- ✅ **3.19.13** Every automated step records what it cost to run — provider, model, billed quantity, spend and the provider's own request id — against the recording that caused it, so the running cost of the library is measured rather than estimated.

### 📝 3.20 External distribution

*Publishing outward happens from inside the app. No manual export, no re-upload, no separate tooling.*

**Functional requirements**

- 📝 **3.20.1** Only Admins can publish to external platforms.
- 📝 **3.20.2** Admins publish a teaching series to Spotify as a podcast, following the feed and episode mapping at 5.3.1.
- 📝 **3.20.3** Generated video reels (3.11) are published to Instagram, TikTok and LinkedIn from the video catalogue.
- 📝 **3.20.4** An admin publishes an episode to Spotify directly from the recording page once the recording is live in the app.
- 📝 **3.20.5** For video, an admin selects a video, chooses one or more target platforms, writes a caption per platform, and either publishes immediately or schedules for later.
- 📝 **3.20.6** Each social platform has its own publishing queue, visible in the admin dashboard (3.19.11). Spotify has no queue, because nothing is pushed to it: a recording is either in its series' feed or it is not (5.3.6).
- 📝 **3.20.7** Publication status is tracked per item per social platform, so an admin can always see what has gone out where. Spotify is tracked per series rather than per episode — the feed's health and when Spotify last read it — because no per-episode status exists to track (5.3.6).
- 📝 **3.20.8** Every external publish is logged with timestamp, platform, item and the admin who triggered it, for audit purposes.
- 📝 **3.20.9** A failed external publish surfaces the reason and can be retried without rebuilding the item.
- 📝 **3.20.10** Series metadata — title, description and cover artwork (3.3.3, 3.3.5) — populates the podcast feed automatically rather than being re-entered.

### 🔨 3.21 Content pipeline & back-catalogue processing

*The operational rhythm the product exists to support, and the mechanism for bringing years of existing teaching into it.*

#### 🔨 3.21.1 Weekly pipeline

| Step | Action                                                              | Owner               | Feature          |
| :--- | :------------------------------------------------------------------ | :------------------ | :--------------- |
| 1    | Record teaching session                                             | Teacher / Admin     | —               |
| 2    | Upload recording                                                    | Admin / Contributor | 3.2.1            |
| 3    | Audio processing: noise reduction, voice enhancement, normalisation | Automated           | 3.4              |
| 4    | Transcription                                                       | Automated           | 3.5              |
| 5    | Summary, scripture references and tags generated as drafts          | Automated           | 3.6, 3.7, 4.17.1 |
| 6    | Mind map generated                                                  | Automated           | 3.8.1            |
| 7    | Cross-references computed against the existing library              | Automated           | 3.9.6            |
| 8    | Metadata, summary and references reviewed and approved              | Admin               | 4.17.2           |
| 9    | Recording published, members notified                               | Admin               | 3.2.2, 3.17.4    |
| 10   | Reflective questionnaire authored and attached                      | Admin               | 3.13             |
| 11   | Video content produced from the teaching                            | Admin / Contributor | 3.11             |
| 12   | Members listen, annotate, reflect                                   | All members         | 3.2, 3.12, 3.13  |
| 13   | External distribution to Spotify and social platforms               | Admin               | 3.20             |

#### 🔨 3.21.2 Pipeline requirements

- 🔨 **3.21.2.1** Steps 3 through 7 run automatically on upload without admin intervention.
- ✅ **3.21.2.2** Steps 3 through 7 produce drafts only. The pipeline does not advance past step 8 without the admin confirmation required by 4.17.3.
- ✅ **3.21.2.3** A failure to produce an automated step's artefact halts that recording's pipeline and flags it (3.19.4) rather than publishing partial results. A failure in something a step layers on top of its artefact — verse text fetched for a citation it has already produced (3.7.4) — degrades that convenience instead, and the step succeeds.
- ✅ **3.21.2.4** An admin can re-run any individual automated step for a recording without re-running the whole pipeline.
- ✅ **3.21.2.5** Nothing retries by itself. A failed step stays failed until an admin re-runs it, so a failure that spends money at a provider cannot repeat unattended overnight.
- ✅ **3.21.2.6** Every step is executed at least once and every step is idempotent, so a run that is interrupted leaves no partial result. Work left behind by a process that stopped mid-step is reclaimed rather than lost, and becomes re-runnable through 3.21.2.4.
- ✅ **3.21.2.7** Re-running a step re-runs the steps that depend on it: re-transcribing a recording regenerates the draft summary and description built on the old words, and discards the transcript corrections made against them. That is why a re-run of that particular step asks for confirmation and the others do not.

#### 📝 3.21.3 Back-catalogue processing

- 📝 **3.21.3.1** Historical teachings can be uploaded in bulk rather than one at a time.
- 📝 **3.21.3.2** Bulk-uploaded recordings run through the same pipeline: processing, transcription, summary, scripture references, tags, mind map and cross-referencing.
- 📝 **3.21.3.3** Batch processing is rate-limited and runs in the background so it does not delay the current week's upload.
- 📝 **3.21.3.4** AI populates all metadata fields in bulk, and an admin reviews them through the Pending Reviews queue (3.19.2) rather than opening each recording individually.
- 📝 **3.21.3.5** An admin can approve a batch of reviewed recordings in one action.
- 📝 **3.21.3.6** Back-catalogue recordings can be assigned to series in bulk.

## 4. Data & metadata definitions

*What data exists in the product and who owns each field. Conceptual — this describes ownership and provenance, not storage.*

### 4.1 User account

| Field                    | Set by                 | Notes                                                                     |
| :----------------------- | :--------------------- | :------------------------------------------------------------------------ |
| Email address            | User-set at invitation | Identity and login (3.1.1)                                                |
| Display name             | User-set               | Shown on public notes and SOS signals (3.1.12)                            |
| Avatar                   | User-set               | Optional                                                                  |
| Role                     | Admin-set              | Admin, Contributor or Member (3.1)                                        |
| Status                   | Admin-set              | Invited, active or deactivated; deactivation is reversible (3.1.7)        |
| Notification preferences | User-set               | Per event category (3.17.13)                                              |
| Preferred playback speed | User-set               | One of the six steps at 3.2.4, applied to every recording on every device |
| Password                 | User-set               | Held only as a hash; reset, never recovered (3.1.6, 3.1.13)               |
| Date joined              | Auto-set               | On invitation acceptance                                                  |

### 4.2 Recording

| Field                | Set by                       | Notes                                                                                                                                                                 |
| :------------------- | :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title                | Admin-set                    | Confirmed at upload                                                                                                                                                   |
| Description          | AI-suggested, admin-editable | 1–3 sentences from the transcript                                                                                                                                    |
| Topics / tags        | AI-suggested, admin-editable | Admin can add or remove (4.7)                                                                                                                                         |
| Scripture references | AI-suggested, admin-editable | Structured citations (3.7.3)                                                                                                                                          |
| Date recorded        | Admin-set                    | Primary sort key (3.3.1)                                                                                                                                              |
| Series               | Admin-set                    | Optional (3.3.9)                                                                                                                                                      |
| Duration             | Not stored                   | Read from the media by the player at playback time. Nothing inspects the file on upload, so no list shows a running time and no progress is expressed as a percentage |
| Publication status   | Admin-set                    | Draft or published (3.2.2, 3.2.11)                                                                                                                                    |
| Original audio       | Auto-retained                | Unmodified upload, held in object storage that is never publicly addressable and reachable only through a signed URL (3.4.9, 3.2.13)                                  |
| Processed audio      | Auto-generated               | Output of 3.4. Until that step exists, the original is what is streamed                                                                                               |

### 4.3 Series

| Field                       | Set by          | Notes                                                                                        |
| :-------------------------- | :-------------- | :------------------------------------------------------------------------------------------- |
| Title                       | Admin-set       | Also the podcast feed title (3.20.10)                                                        |
| Description                 | Admin-written   | Series themes and goals                                                                      |
| Cover artwork               | Admin-uploaded  | Series poster and podcast artwork (3.3.3)                                                    |
| Date range                  | Auto-calculated | Earliest to latest recording the reader may see                                              |
| Recording count             | Auto-calculated | Over the recordings the reader may see, so a member counts published recordings only (3.3.5) |
| External publication status | Auto-tracked    | Per platform (3.20.7)                                                                        |

### 4.4 Transcript

| Field             | Set by                            | Notes                                                                            |
| :---------------- | :-------------------------------- | :------------------------------------------------------------------------------- |
| Source recording  | Auto-set                          | One transcript per recording                                                     |
| Segments          | Auto-generated                    | Each with start and end timestamps (3.5.2)                                       |
| Text              | Auto-generated, admin-correctable | 3.5.5                                                                            |
| Language          | Pinned                            | English, recorded on the transcript rather than detected (3.5.7)                 |
| Speaker           | Auto-generated                    | The provider's anonymous index, per segment, nullable and never editable (3.5.9) |
| Corrected by / at | Auto-set                          | Recorded per segment when a human changes it (3.5.5)                             |
| Confidence        | Auto-generated                    | Drives the flag at 3.5.8                                                         |

### 4.5 AI summary

| Field               | Set by                       | Notes                                                                          |
| :------------------ | :--------------------------- | :----------------------------------------------------------------------------- |
| Source recording    | Auto-set                     | One summary per recording                                                      |
| Text                | AI-generated, admin-editable | Plain text with line breaks (3.6.8)                                            |
| Status              | Admin-set                    | Draft or published (3.6.2, 3.6.12)                                             |
| Date generated      | Auto-set                     | Reset on regeneration                                                          |
| Generated by        | Auto-set                     | Which model, which model version and which prompt version produced it (4.17.5) |
| Regeneration prompt | Admin-set                    | Optional steer, retained with the draft it produced (3.6.9)                    |

### 4.6 Scripture reference

| Field                      | Set by                       | Notes                                                                     |
| :------------------------- | :--------------------------- | :------------------------------------------------------------------------ |
| Book, chapter, verse range | AI-suggested, admin-editable | Structured, not free text (3.7.3)                                         |
| Source recording           | Auto-set                     | Which teaching cites it                                                   |
| Origin                     | Auto-set                     | Whether the machine proposed this reference or an admin added it (4.17.5) |
| Edited by admin            | Auto-set                     | Whether an admin changed it before approving (4.17.5)                     |

A reference carries no status of its own. Suggested-versus-accepted is the state of the review item that holds the draft (4.17.6): a reference exists only once an admin has approved the list it belongs to, so a status field here would be a second answer to a question the review item already answers.

### 4.7 Topic / tag

| Field      | Set by                       | Notes                                  |
| :--------- | :--------------------------- | :------------------------------------- |
| Name       | Admin-set                    | Admins can create new tags at any time |
| Applied to | AI-suggested, admin-editable | Typically 3–6 per item                |

- Tags form a single shared taxonomy across recordings and videos: a tag used on a recording is the same tag used on a video.
- Tags are a foundation for cross-referencing (3.9.3) and search (3.10.4).

### 4.8 Video

| Field              | Set by                                   | Notes                                       |
| :----------------- | :--------------------------------------- | :------------------------------------------ |
| Title              | Admin-set                                | Can differ from the parent recording title  |
| Description        | Admin-written                            | Short context for the video                 |
| Topics / tags      | Inherited from parent, admin-overridable | 3.11.5.4                                    |
| Video type         | Admin-set                                | Reel or summary video (3.11.1)              |
| Parent recording   | Auto-set                                 | The source teaching                         |
| Style preset       | Admin-set                                | 3.11.2                                      |
| Audio layer        | Admin-set                                | Original or AI voiceover (3.11.4.4)         |
| Duration           | Auto-extracted                           | On generation                               |
| Publication status | Admin-set                                | Internal and per external platform (3.20.7) |

### 4.9 Mind map

| Field                   | Set by                                               | Notes                                         |
| :---------------------- | :--------------------------------------------------- | :-------------------------------------------- |
| Source                  | Auto-set                                             | Parent recording or video                     |
| Kind                    | Auto-set                                             | Recording map (3.8.1) or personal map (3.8.5) |
| Generated by            | Auto-set                                             | Determines visibility                         |
| Date generated          | Auto-set                                             | Sort key in the personal library (3.8.8)      |
| Nodes and relationships | AI-generated; admin-editable for recording maps only | 3.8.2, 3.8.11                                 |
| Share link              | User-set                                             | Personal maps only, reversible (3.8.13)       |

Mind maps carry no title: the source recording or video title labels them in the library.

### 4.10 Timestamp note

| Field       | Set by               | Notes                                                             |
| :---------- | :------------------- | :---------------------------------------------------------------- |
| Recording   | Auto-set             | Which teaching the note belongs to                                |
| Timestamp   | Auto-set             | Playback position at creation (3.12.1)                            |
| Author      | Auto-set             | The member who wrote it                                           |
| Text        | User-set             | Plain text, 1,000 characters (3.12.5)                             |
| Visibility  | User-set at creation | Public or private (3.12.4)                                        |
| Parent note | Auto-set             | Present on replies only, one level (3.12.7)                       |
| Reactions   | User-set             | One per member per note (3.12.14)                                 |
| Pinned      | Admin-set            | Any number per recording; a note is pinned at most once (3.12.15) |
| Status      | Auto-set             | Active or deleted                                                 |

### 4.11 Questionnaire & response

| Field           | Set by        | Notes                                                         |
| :-------------- | :------------ | :------------------------------------------------------------ |
| Recording       | Admin-set     | One questionnaire per recording (3.13.1)                      |
| Questions       | Admin-written | Open reflection, multiple choice or scripture prompt (3.13.4) |
| Response        | User-set      | Private to the member (3.13.8)                                |
| Response status | Auto-set      | In progress or complete (3.13.7)                              |
| Last updated    | Auto-set      | Responses remain editable (3.13.9)                            |

### 4.12 Flow tracker session

| Field               | Set by         | Notes                                     |
| :------------------ | :------------- | :---------------------------------------- |
| Member              | Auto-set       | Strictly private (3.14.8)                 |
| Divergence point    | User-set       | The teaching they fell behind at (3.14.2) |
| Questions presented | Auto-assembled | From content and question banks (3.14.4)  |
| Responses           | User-set       | Never scored (3.14.9)                     |
| Recommendations     | Auto-generated | Recording plus timestamp links (3.14.7)   |
| Session status      | Auto-set       | In progress or complete (3.14.10)         |

### 4.13 Question bank

| Field     | Set by        | Notes                             |
| :-------- | :------------ | :-------------------------------- |
| Scope     | Admin-set     | Attached to a teaching or a topic |
| Questions | Admin-written | Feeds the Flow Tracker (3.14.11)  |

### 4.14 Highlight entry

| Field       | Set by   | Notes                                           |
| :---------- | :------- | :---------------------------------------------- |
| Member      | Auto-set | Private to them (3.15.9)                        |
| Target      | User-set | Recording, segment or own note (3.15.1–3.15.3) |
| Timestamp   | Auto-set | Present for segment and note entries            |
| Date pinned | Auto-set | Shown in the playlist (3.15.6)                  |

### 4.15 SOS signal

| Field                    | Set by              | Notes                                     |
| :----------------------- | :------------------ | :---------------------------------------- |
| Author                   | Auto-set            | Never anonymous (3.16.13)                 |
| Urgency                  | User-set            | Red, orange, yellow or green (3.16.1)     |
| Description              | User-set            | Short free text (3.16.2)                  |
| Raised at                | Auto-set            | Sort key (3.16.4)                         |
| Praying acknowledgements | User-set            | One per member (3.16.5)                   |
| Replies                  | User-set            | Visible to all members (3.16.6)           |
| Status                   | Author or admin-set | Open, closed or removed (3.16.8–3.16.11) |
| Closing note             | Author-set          | Optional (3.16.8)                         |

### 4.16 Notification

| Field              | Set by       | Notes                                           |
| :----------------- | :----------- | :---------------------------------------------- |
| Event type         | Auto-set     | One of 3.17.4–3.17.12                          |
| Recipient          | Auto-derived | From the event's audience                       |
| Source item        | Auto-set     | What to open when selected (3.17.3)             |
| Read state         | Auto-set     | Drives the unread count                         |
| Delivered channels | Auto-set     | Push, in-app, or both per preferences (3.17.13) |

### 🔨 4.17 Metadata population workflow

- 🔨 **4.17.1** On upload, AI processes the transcript and suggests description, topics and tags, and scripture references.
- ✅ **4.17.2** The admin sees suggestions pre-filled in the review form and can accept, edit or discard each field individually.
- ✅ **4.17.3** Nothing publishes automatically. An admin must confirm before a recording goes live (3.2.2, 3.21.2.2).
- 📝 **4.17.4** Back-catalogue batches follow the bulk review path defined at 3.21.3.4.
- ✅ **4.17.5** Every AI-suggested field records that it was AI-suggested and whether an admin changed it, alongside the model, model version and prompt version that produced it and any steering prompt used (3.6.14).
- ✅ **4.17.6** Every AI artefact awaiting review is the same kind of item, distinguished by what kind of artefact it holds. Summary and description are the two kinds today; scripture references, tags, mind maps and video scripts become further kinds of the same item rather than queues of their own, which is what keeps 3.19.2 one queue and one review form however many artefacts the pipeline learns to produce.

### 4.18 Pipeline job

*One row per run of one automated step, and the record the pipeline status view (3.19.4) reads.*

| Field                         | Set by   | Notes                                                                                                           |
| :---------------------------- | :------- | :-------------------------------------------------------------------------------------------------------------- |
| Recording                     | Auto-set | Which teaching the step belongs to                                                                              |
| Step                          | Auto-set | Which stage of the pipeline (3.21.1)                                                                            |
| Status                        | Auto-set | Pending, running, succeeded or failed. There is no retrying state, because nothing retries by itself (3.21.2.5) |
| Attempt                       | Auto-set | Which run of that step this is. Every run is its own record; earlier ones are kept                              |
| Error                         | Auto-set | Why the latest attempt failed, shown on the pipeline view (3.19.4)                                              |
| Enqueued / started / finished | Auto-set | The three timestamps the pipeline view reads                                                                    |
| Provider metadata             | Auto-set | Model, billed quantity, spend and the provider's request id (3.19.13)                                           |
| Correlation id                | Auto-set | Ties the job back to the request that caused it (§6, Auditability)                                             |

## 5. Platform & distribution

### 🔨 5.1 Progressive Web App

| #     |     | Capability         | Requirement                                                                             | Notes                                                        |
| :---- | :-- | :----------------- | :-------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| 5.1.1 | 📝  | Installable        | Add to home screen on iOS and Android                                                   | Behaves as an app once installed                             |
| 5.1.2 | 📝  | Offline support    | Downloaded recordings and their attached content available with no connectivity         | Full requirements at 3.18                                    |
| 5.1.3 | 📝  | Background audio   | Playback continues when backgrounded or the device is locked, with lock-screen controls | Critical for mobile listening (3.2.6)                        |
| 5.1.4 | 📝  | Push notifications | Device-level delivery when the app is closed                                            | Event model at 3.17                                          |
| 5.1.5 | 🔨  | Responsive design  | Usable on phone, tablet and desktop from one codebase                                   | Admin work is desktop-weighted; member use is phone-weighted |
| 5.1.6 | 🔨  | Media handling     | Large audio upload, streaming playback, video playback                                  | 3.2, 3.11                                                    |
| 5.1.7 | 📝  | Local storage      | Downloaded media and pending offline writes held on device                              | 3.18.11, 3.18.14                                             |

### 🔨 5.2 App store distribution

*The product remains a single PWA codebase. The app stores are a distribution channel for it, not a second platform — there is no separate native application.*

- 📝 **5.2.1** The PWA is packaged and listed in the Apple App Store and Google Play, so members can find and install it the way they install any other app.
- 🔨 **5.2.2** Store builds and the browser-delivered PWA serve the same product from the same codebase. A feature never exists in one and not the other.
- 📝 **5.2.3** Store listings carry the product's name, icon, screenshots, description and category, and a privacy policy covering the data described in section 4.
- 📝 **5.2.4** Content updates and feature releases reach members through the web layer without requiring a store review cycle for every change.
- 📝 **5.2.5** Push notifications (3.17.1) function in the store-distributed builds as well as in the browser PWA.
- 📝 **5.2.6** Both stores require in-app account deletion of any app that offers account creation, which is what makes 3.1.8 a compliance requirement rather than a convenience.
- ✅ **5.2.7** The product involves no payments, subscriptions or in-app purchases, so neither store's commerce rules apply to it.
- 📝 **5.2.8** Age rating and content declarations reflect the product's religious content and its member-generated notes and SOS messages.

### 🔨 5.3 External content platforms

*How each external channel behaves. The admin-facing publishing capability is specified at 3.20.*

- 📝 **5.3.1** **Spotify.** Teaching series are distributed as podcasts: a series maps to a feed, a recording maps to an episode. The feed draws its title, description and artwork from series metadata (4.3), and episodes carry the processed audio (3.4.10) with the recording's title, description and date. Series metadata is podcast-shaped from creation (3.3.7).
- 📝 **5.3.2** Series cover artwork must satisfy podcast artwork requirements — square, high resolution — which constrains what an admin uploads at 3.3.3.
- 📝 **5.3.3** **Instagram, TikTok and LinkedIn.** Generated reels (3.11.1.1) are published as short-form video. Each platform imposes its own duration limits, aspect ratio and caption conventions, which is what makes the per-platform publishing choices at 3.20.5 necessary.
- 📝 **5.3.4** Video style presets (3.11.2) are defined so that generated output meets the aspect ratio and duration expectations of the target platforms rather than being reformatted afterwards.
- ✅ **5.3.5** Every external platform is publish-only. No comments, followers or engagement data are pulled back into the product.
- 📝 **5.3.6** Spotify is reached by polling, not by pushing: it reads the feed on its own schedule and offers no API to publish or confirm a single episode. So the product knows only two things about an episode — that it is in the feed, and when Spotify last read that feed — and 3.20.6 and 3.20.7 promise nothing more than those two. The three social platforms are the opposite and are tracked per item.

## 6. Non-functional requirements

| # |  | Category            | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| :---- | :-- | :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | 🔨 | Scalability         | Supports 100 members at launch and scales to 1,000+ without re-architecture. Content volume grows unbounded: weekly additions plus the full back catalogue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6.2 | 🔨 | Performance         | Audio streaming begins within 2 seconds of pressing play. Search returns results within 2 seconds. Video plays smoothly at target resolutions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6.3 | ✅ | Processing latency  | The automated pipeline (3.21.2.1) completes within a few hours of upload, so a recording uploaded after a session is reviewable the same day.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6.4 | ✅ | Storage             | Permanent retention of original and processed audio, transcripts, generated videos, mind maps, notes and all member-generated content. Nothing expires.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6.5 | 📝 | Availability        | Downloaded content remains fully usable during any outage. Degradation is graceful: a failure in AI generation or external publishing never blocks listening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6.6 | ✅ | Security            | Authentication required for all content. Role-based access enforced server-side. Media storage is not publicly addressable. Every authorisation decision is evaluated in one place, against an actor, an action and a resource, and denies by default — a capability nobody wrote a rule for is refused rather than permitted. The unauthenticated surface is an enumerated list of routes rather than a convention, and no entry on it returns content. Passwords are held only as hashes; sessions are server-side and revocable on the spot; media is reached only through short-lived signed URLs issued after the authorisation check has already passed. |
| 6.7 | 🔨 | Privacy             | Private member content — private notes, personal mind maps, questionnaire responses, Flow Tracker sessions, Highlights — is never visible to other members or to admins, and never surfaces in another member's search results (3.10.9).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6.8 | 📝 | Audio quality       | One consistent sound profile across the entire library, with output suitable for both in-app playback and podcast distribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6.9 | 📝 | Offline capability  | Offline is a first-class mode, not a fallback. Members can complete a full listening session with no connectivity and sync cleanly on return.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6.10 | ✅ | API-first           | The product's capabilities are exposed through an API layer rather than being embedded in the interface, so store-packaged builds, the browser PWA and external publishing all work against the same contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6.11 | 🔨 | Content integrity   | AI-generated content accurately reflects the teaching it derives from. Every AI output passes an admin review gate before any member sees it (4.17.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6.12 | 🔨 | Auditability        | External publishes (3.20.8) and admin actions on member content (3.12.10, 3.16.11) are logged with actor and timestamp. Every request and every pipeline job carries one correlation id through the application, the worker and the logs, so a single action is followable end to end across both processes.                                                                                                                                                                                                                                                                                                                                                    |
| 6.13 | ✅ | Operability         | The product answers a health check that reflects a real database round-trip and is readable without a session, so monitoring never needs a credential. Both processes are supervised, start on boot and restart on failure. Logs are structured and carry the correlation id of the request or job that produced them.                                                                                                                                                                                                                                                                                                                                          |
| 6.14 | ✅ | Durability          | The database is backed up nightly with continuous write-ahead archiving to object storage held separately from the media bucket, and a restore is proven by drill rather than assumed. An unverified backup is not a backup.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6.15 | ✅ | Cost accountability | Every provider call records what it spent — model, billed quantity, cost and the provider's request id — against the job that made it, so running cost is measured rather than estimated. A single switch puts every external provider into a local mock, so no development or test run can reach a paid one by accident.                                                                                                                                                                                                                                                                                                                                     |
| 6.16 | 🔨 | Accessibility       | Text is legible at increased system font sizes, controls are reachable by keyboard on desktop, and media controls carry accessible labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 7. Technical feasibility & high-level approach

*This section exists to show the product above can be built and to sketch how. It deliberately stops short of designing it.*

**How it works, in outline.** A recording enters the system through an upload from an admin or contributor and lands in durable media storage. From there an asynchronous processing chain runs: clean and normalise the audio, transcribe it into timestamped segments, then fan out to the derived artefacts — summary, scripture references, tags, mind map — each produced as a draft. Segment text is additionally turned into a semantic representation that supports both similarity matching between teachings and meaning-based search. Everything generated waits at an admin review gate; only on approval does content become member-visible. Members reach the product through a web application that also serves as an installable PWA, packaged for the two app stores from the same codebase. That application talks to a backend API which owns access control, playback progress, notes, questionnaires and every other piece of member state, and pushes events out through a notification service. Offline works because the client keeps its own copy of downloaded media and any writes made while disconnected, reconciling with the server when connectivity returns. Video generation and external publishing run as their own asynchronous jobs, triggered by an admin and reported back through the same notification path.

**What makes it possible.**

- Speech-to-text with word- or segment-level timestamps — the single capability everything downstream depends on (3.5). **Deepgram**'s pre-recorded API on the English Nova-3 model is what fills it today, behind a one-file adapter, with the provider handed a short-lived signed location to fetch the audio from rather than the bytes themselves.
- A general-purpose language model for summarisation, tagging, scripture identification, mind map extraction and video script assembly (3.6, 3.7, 3.8, 3.11.3.1). **MiniMax M3**, over its Anthropic-compatible endpoint, fills it today behind the same shape of adapter; structured output is taken as a forced tool call, and a model that answers in prose instead fails the step visibly rather than writing something nobody asked for.
- Semantic similarity over text segments, which is what makes cross-referencing (3.9) and meaning-based search (3.10) the same underlying capability rather than two separate builds.
- Generative video with text-to-speech, for reels and summary videos (3.11).
- Audio processing capable of noise reduction, clarity enhancement and loudness normalisation as a repeatable profile (3.4).
- Transactional email delivery, for the two flows that cannot complete without it: invitation (3.1.3) and password reset (3.1.6). **Resend**, sent over SMTP so the provider is configuration rather than code. It is named here because the choice is settled and consequence-free: no notification in 3.17 uses email — both channels there are push (3.17.1) and in-app (3.17.2) — so email volume never grows with content or activity, only with new accounts. Dozens of messages a month at 100 members and at 1,000, which sits inside Resend's free tier at both ends.
- Web platform capabilities the PWA leans on directly: service workers and local storage for offline (3.18), background audio with lock-screen controls (3.2.6), and web push (3.17.1).
- External dependencies outside our control: Spotify's podcast ingestion, the Instagram, TikTok and LinkedIn publishing APIs (3.20), a source of Bible verse text (3.7.4), and the Apple and Google app store review processes (5.2).

**Hard parts & unknowns.**

- **App store acceptance.** Apple applies a minimum-functionality standard to web-wrapped applications. Rejection would not affect the product itself but would remove a distribution channel the product currently assumes, so 5.2 carries real risk.
- **Push notifications across delivery routes.** Web push on iOS behaves differently from push in a store-packaged build, and the two may not be reachable through one mechanism. If they are not, 3.17.1 costs more than it appears to.
- **Generative video quality, cost and turnaround.** This is the least proven capability in the product. If output quality or per-video cost disappoints, 3.11 changes shape — the feature survives but the workflow around it may need to lean far harder on manual selection.
- **Offline storage limits on mobile.** Browser-managed storage can be evicted under pressure and is capped on iOS. "Download all" for a long series (3.18.6) may collide with that ceiling, which would force a cap or an eviction policy the product does not currently describe.
- **Bible text licensing.** Displaying full verse text (3.7.4) is a licensing question, not a technical one, and it differs sharply by translation. **Answered for the translation the product runs on**: a free-use source and one configured translation (3.7.9), with verses rendered inline. It re-opens only if the ministry wants a translation that is not free to use — most of the well-known ones are not — which would be a licensing negotiation before it is a code change.
- **Cross-referencing cold start.** Similarity between teachings (3.9) is only as useful as the library is large. Early on it will surface little, and the feature will look weaker than it is until the back catalogue is processed (3.21.3).
- **Transcription accuracy on ministry-specific language.** Names, places and theological terminology are where speech-to-text degrades, and every downstream artefact inherits that error. The admin correction path (3.5.5) is a genuine requirement, not a convenience.
- **Cost at back-catalogue scale.** Running years of recordings through transcription, summarisation and embedding is a one-off cost concentrated in a short window (3.21.3.3), and needs to be sized before committing.

**Since settled, and recorded here because the product now runs on them.** Speech-to-text is Deepgram Nova-3 and drafting is MiniMax M3, both named above; transactional email is Resend over SMTP. Media is held in S3-compatible object storage that is never publicly addressable, written by the browser under a presigned upload grant and read only through a short-lived signed URL. The application, its API and the job orchestration are one codebase plus a single worker process, and the job ledger is itself the queue — there is no broker, which is what makes enqueueing a step transactional with the write that caused it and makes the status view at 3.19.4 one query rather than a log read. Persistence is a single PostgreSQL database with pgvector installed but not yet enabled, so cross-referencing and search (3.9, 3.10) can be built on the datastore that already holds the content and its access rules. Each of these sits behind a narrow adapter, which is what keeps replacing one of them a one-file change rather than a re-architecture.

**Settled since, and recorded in the TDD rather than here.** Four things this section once left open now have decisions: the PWA is packaged for both stores with Capacitor (project tdd 4.3), search needs no infrastructure beyond the datastore above (project tdd 4.4, 4.5), offline synchronisation resolves conflicts per entity (project tdd 5.3), and embeddings are 1536-dimensional (project tdd 4.4).

**Deliberately deferred, with a home.** Which embedding, video and text-to-speech providers are used is decided in the scope that first needs one, against measured output rather than in advance — project tdd 4.10 and 4.11 say why that deferral is cheap, and each provider sits behind an adapter narrow enough that choosing wrongly costs one file.
