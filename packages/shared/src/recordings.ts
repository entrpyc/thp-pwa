/**
 * The recording wire contract, and the two rules an upload has to satisfy.
 *
 * Read by the API, by the admin upload screen and by the media store, so none of the three can
 * invent its own idea of what is acceptable. The size ceiling and the accepted formats are
 * **operator decisions** recorded in
 * core-listening scope tdd § Key choices, "Two inputs this epic needs and
 * nothing defines", item 2 — stated once here so the screen can say the limit *before* a file is
 * chosen and the API can refuse the same file for the same reason.
 *
 * **No shape in this file carries a URL to read the media with.** The presigned `PUT` is the one
 * URL that crosses the wire, and it exists only in the grant that mints it; playback is a signed
 * `GET` that Story 4 owns and no type here anticipates.
 */

/** Paths of the recording resource, relative to the `/api/v1` prefix. */
export const RECORDINGS_PATH = '/recordings';

/** Where a browser asks for permission to `PUT` the bytes it is about to send. */
export const RECORDING_UPLOADS_PATH = '/recordings/uploads';

/** The recordings panel, on the web origin rather than under the API prefix. */
export const ADMIN_RECORDINGS_PAGE_PATH = '/admin/recordings';

/**
 * The member landing, on the web origin. `pages/dashboard.png`.
 *
 * `/` rather than `/dashboard`: a signed-in member arriving at the root has arrived somewhere, and
 * the placeholder screen that used to sit here retired with Story 4 Ticket 01.
 */
export const DASHBOARD_PAGE_PATH = '/';

/** The member library, on the web origin. Every published teaching, newest recorded first. */
export const MEMBER_LIBRARY_PAGE_PATH = '/recordings';

/** One teaching's page, on the web origin. `pages/recording.png`. */
export function recordingPagePath(recordingId: string): string {
  return `${MEMBER_LIBRARY_PAGE_PATH}/${recordingId}`;
}

/**
 * Whether a path is a route that **opens a teaching of its own**.
 *
 * Beside the builder above so the two cannot drift: the player asks this before restoring the last
 * sitting into the transport, because a page that is about to open a teaching does not want one
 * opened underneath it first.
 *
 * **Two routes answer yes**, and the name is about the *behaviour* rather than about one address: a
 * teaching's own page, and a chapter's page under it ([3.22.13](docs/project/prd.md)), which opens
 * the same teaching for the same reason. A chapter page that let the resume effect run first would
 * spend a grant and a notes fetch on the previous sitting, and would name it on the bar for the
 * seconds before this page replaced it — the exact cost the exclusion exists to avoid.
 *
 * Deliberately **not** a general "starts with `/recordings/`": the library is not one of these, and
 * a third route under a teaching that does not open it should not silently become one.
 */
export function isRecordingPagePath(path: string): boolean {
  const rest = path.startsWith(`${MEMBER_LIBRARY_PAGE_PATH}/`)
    ? path.slice(MEMBER_LIBRARY_PAGE_PATH.length + 1)
    : null;
  if (rest === null || rest === '') return false;

  const segments = rest.split('/');
  // `/recordings/{id}` — the teaching's own page.
  if (segments.length === 1) return true;
  // `/recordings/{id}/chapters/{chapterId}` — a chapter of it, which opens the same teaching.
  return segments.length === 3 && segments[1] === CHAPTERS_SEGMENT && segments[2] !== '';
}

/**
 * The path segment a chapter page sits under.
 *
 * Here rather than in `chapters.ts` because {@link isRecordingPagePath} reads it and `chapters.ts`
 * already reads this file for its paths — one direction, no cycle. It is the one string the two
 * files have to agree on, so it is written once.
 */
export const CHAPTERS_SEGMENT = 'chapters';

/** One recording, under the API prefix. */
export function recordingPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}`;
}

/**
 * **Which surface is asking** — the query parameter that makes "one route, two shapes" a request
 * the caller states rather than a role the API infers (Story 4 Ticket 01).
 *
 * Without it, an admin opening the member library would see the console's answer: unpublished rows
 * and object keys, in a screen that is supposed to show what a member sees. Inferring the shape
 * from `recording.list` is what causes that, and it is why the member surface says so explicitly
 * instead.
 *
 * Absent means the console's reading, so nothing that already calls this route changed. It is not
 * a permission — a member asking for the console's shape still gets a member's rows, because the
 * policy answers that question and this parameter never does.
 */
export const RECORDING_SURFACE_PARAM = 'surface';

/**
 * The value that asks for it.
 *
 * Named after the *screen* rather than the person at it, and not only because tools/role-usage.ts
 * refuses a role spelled out in a string outside the policy module. An admin asking for this is not
 * claiming to be a member — they are asking what the library shows.
 */
export const LIBRARY_SURFACE = 'library';

/** The library, as a member reads it — published rows only, whatever the caller's role. */
export const MEMBER_RECORDINGS_PATH = `${RECORDINGS_PATH}?${RECORDING_SURFACE_PARAM}=${LIBRARY_SURFACE}`;

/** One teaching, as a member reads it. The read the recording page makes. */
export function memberRecordingPath(recordingId: string): string {
  return `${recordingPath(recordingId)}?${RECORDING_SURFACE_PARAM}=${LIBRARY_SURFACE}`;
}

/**
 * 200 MB, counted as 200 × 1024 × 1024 — the operator's ceiling, and the number the screen prints.
 *
 * What it implies, because it is discovered at the first upload otherwise: a 90-minute teaching
 * fits comfortably as mp3 or m4a (~85 MB at 128 kbps, ~135 MB at 192 kbps) and **does not fit as
 * WAV or FLAC**, which run to several hundred megabytes at that length. So the working path is a
 * compressed export, and the lossless formats are accepted only for shorter recordings.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** The ceiling as a person reads it. One statement, so the screen and the API say the same words. */
export const MAX_UPLOAD_LABEL = '200 MB';

/**
 * The accepted formats, keyed by the extension a person sees and carrying the content type the
 * upload is signed for.
 *
 * The **client checks the extension** — it is what a file picker actually gives you, and a browser's
 * own idea of a file's MIME type varies by platform for exactly these formats (`audio/x-m4a`,
 * `audio/vnd.wave`, an empty string). The **server checks the content type**, because that is what
 * the presigned `PUT` is bound to and what the store reports back at finalisation. Deriving the
 * type from the extension here is what keeps the two checks answers to the same question.
 */
export const ACCEPTED_AUDIO_FORMATS = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
} as const;

export type AudioExtension = keyof typeof ACCEPTED_AUDIO_FORMATS;

export const ACCEPTED_AUDIO_EXTENSIONS = Object.keys(ACCEPTED_AUDIO_FORMATS) as AudioExtension[];

/**
 * Every content type the API will sign a grant for.
 *
 * Two of the five formats have a second spelling in the wild — `audio/x-wav` and `audio/x-flac` —
 * so both are accepted on the way in. Only the canonical spelling above is ever *minted*, which is
 * what keeps the extension the key ends in a function of one table rather than of what was sent.
 */
export const ACCEPTED_AUDIO_TYPES: readonly string[] = [
  ...Object.values(ACCEPTED_AUDIO_FORMATS),
  'audio/x-wav',
  'audio/x-flac',
];

/** The formats as a person reads them, for the sentence the upload screen prints. */
export const ACCEPTED_AUDIO_LABEL = 'MP3, M4A, AAC, WAV or FLAC';

export function isAcceptedAudioType(value: unknown): value is string {
  return typeof value === 'string' && ACCEPTED_AUDIO_TYPES.includes(value.trim().toLowerCase());
}

/** The extension after the last dot, lowercased. `null` when the name carries none. */
export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

export function isAcceptedAudioExtension(value: string | null): value is AudioExtension {
  return value !== null && value in ACCEPTED_AUDIO_FORMATS;
}

/**
 * The content type an upload of this extension is signed for, and the extension the minted key
 * ends in. Both directions of the one table above.
 */
export function contentTypeForExtension(extension: AudioExtension): string {
  return ACCEPTED_AUDIO_FORMATS[extension];
}

export function extensionForContentType(contentType: string): AudioExtension | null {
  const wanted = contentType.trim().toLowerCase();
  const canonical = wanted.startsWith('audio/x-') ? `audio/${wanted.slice('audio/x-'.length)}` : wanted;
  const found = ACCEPTED_AUDIO_EXTENSIONS.find(
    (extension) => ACCEPTED_AUDIO_FORMATS[extension] === canonical,
  );
  return found ?? null;
}

/**
 * `null` when this file may be uploaded, otherwise one sentence saying why it may not.
 *
 * In `shared` for the same reason the password rules and the display-name rule are: the screen has
 * to be able to refuse a file **before any presign request is made**, and one statement of the rule
 * means the screen and the API cannot disagree about what it says. The API asks the same question
 * of the declared size and type, and the store is asked a third time at finalisation — the client
 * holds no decision.
 */
export function checkChosenFile(filename: string, size: number): string | null {
  const extension = extensionOf(filename);
  if (!isAcceptedAudioExtension(extension)) {
    return `That is not an audio file this accepts. Upload ${ACCEPTED_AUDIO_LABEL}.`;
  }
  if (size > MAX_UPLOAD_BYTES) {
    return `That file is ${describeBytes(size)}; the limit is ${MAX_UPLOAD_LABEL}.`;
  }
  return null;
}

/**
 * A file size in the units the limit is stated in, **rounded up, never down**.
 *
 * Up rather than to-nearest because this number is read beside a ceiling: a file one byte over
 * 200 MB rounded to the nearest megabyte reads "That file is 200 MB; the limit is 200 MB", which is
 * a sentence that makes a person doubt the software rather than re-export the file. Erring upward
 * overstates a legal file by under a megabyte and never understates an illegal one.
 */
export function describeBytes(size: number): string {
  const megabytes = size / (1024 * 1024);
  if (megabytes < 1) return `${Math.max(1, Math.ceil(size / 1024))} KB`;
  return `${Math.ceil(megabytes)} MB`;
}

/** Body of `POST /api/v1/recordings/uploads`. */
export interface UploadGrantRequest {
  /** What the person chose it as. Logged, never used to build the key. */
  readonly filename: string;
  readonly contentType: string;
  /** What the browser says the file is. Re-checked against the store at finalisation. */
  readonly size: number;
}

/**
 * Payload of `POST /api/v1/recordings/uploads`.
 *
 * `url` is a presigned `PUT` bound to `key` and to `contentType` and good until `expiresAt`. It
 * cannot be made single-use — presigning has no such thing — which is why `key` is minted
 * server-side per request and is not guessable.
 */
export interface UploadGrantPayload {
  readonly url: string;
  readonly key: string;
  readonly contentType: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}

/** Body of `POST /api/v1/recordings`. */
export interface CreateRecordingRequest {
  /** The key from the grant, now with bytes behind it. */
  readonly key: string;
  readonly title: string;
  /** `YYYY-MM-DD`. The date recorded, not a timestamp — it is the list's sort key. */
  readonly recordedAt: string;
}

/**
 * Body of `PATCH /api/v1/recordings/{id}` — correcting what a teaching is called and when it was
 * given ([3.2.16](docs/project/prd.md)).
 *
 * **Both fields together rather than a partial patch of one**, exactly as `UpdateSeriesRequest`
 * takes both of its: the console edits a recording in one form with two inputs, and "which of
 * these did you mean to change" is a question a two-field form does not raise. Sending the same
 * body twice leaves the same two columns saying the same thing.
 *
 * The same two fields the upload form asked for, under the same rules — a title that is not blank,
 * and a date the calendar actually has. What the request may **not** carry is anything else about
 * the recording: the key is minted at upload and never re-pointed, and publication, series,
 * description and summary each have a control of their own.
 */
export interface UpdateRecordingRequest {
  readonly title: string;
  /** `YYYY-MM-DD`. The date recorded, not a timestamp — it is the list's sort key. */
  readonly recordedAt: string;
}

/** Payload of `PATCH /api/v1/recordings/{id}`, as the console reads the row back. */
export interface UpdateRecordingPayload {
  readonly recording: RecordingSummary;
}

/**
 * The series a recording belongs to, as it travels **on the recording itself** (Story 6).
 *
 * Declared here rather than in `series.ts` because it is a field of {@link RecordingView} and
 * `series.ts` already reads this file for its paths — one direction, no cycle. Three fields and no
 * more: everything else about a series is what opening the series page is for.
 */
export interface RecordingSeriesRef {
  readonly id: string;
  readonly title: string;
  /**
   * The cover of the series this recording is in, signed for this response, or `null` when the
   * series has none (scope prd 3.2.3, scope tdd 1.4).
   *
   * **On the ref rather than on the recording**, because that is what it is: a recording has no
   * artwork of its own and never will in this scope — what its page and the transport show is the
   * cover of the study it belongs to. A recording in no series has no `series` at all, which is
   * why there is no separate "no cover" state to represent here.
   *
   * A URL and never a key, minted per response by `mintArtworkGrant`, exactly as `SeriesView`
   * carries it (scope prd 4.2).
   */
  readonly artworkUrl: string | null;
}

/**
 * A recording as **anyone permitted to see it** may — which from Story 3 Ticket 04 includes a
 * member, because `GET /api/v1/recordings` answers both roles from one query and one visibility
 * condition ([3.2.2](docs/project/prd.md), [3.1.2](docs/project/prd.md)).
 *
 * `summary` is the approved, published summary and is `null` unless **both** gates are open — the
 * summary's own `published_at` and the recording's. The description has no second gate: it is a
 * column on the recording and rides the recording's publish state.
 */
export interface RecordingView {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /** ISO 8601, or `null` while unpublished. Only an admin ever sees the `null`. */
  readonly publishedAt: string | null;
  readonly description: string | null;
  /** The approved summary, when it and the recording are both published. Otherwise `null`. */
  readonly summary: string | null;
  /**
   * The series this recording is in, or `null` for the majority that are in none
   * ([3.3.9](docs/project/prd.md)) — Story 6.
   *
   * On the recording rather than fetched by whatever needs it, so the library row's series label
   * and the recording page's `home › series › recording` trail are both facts about the row rather
   * than about the navigation that reached it.
   */
  readonly series: RecordingSeriesRef | null;
  /**
   * Whether this teaching has any approved scripture references at all
   * (scope prd 3.4.4) — Group 4.
   *
   * A boolean rather than the references themselves, and that is the whole of why it is here: the
   * recording page has to decide whether to draw the **Scripture** tab *before* anything is
   * fetched, because the panel behind it is fetched when the tab is first opened and not before.
   * Without it the page would have to download every passage on load to find out whether to offer
   * them, which is the cost the closed tab exists to avoid.
   *
   * It rides the same gate everything else on this payload does — an unpublished teaching is not
   * readable at all, so there is no state in which this is `true` for somebody who may not see the
   * references it promises.
   */
  readonly hasScripture: boolean;
}

/**
 * The same recording with what only an operator has business with.
 *
 * The service adds these two — and unpublished rows — only when the caller satisfies
 * `recording.list`, which is what keeps "one route, one answer to what may this person see" true
 * without a second endpoint for the console.
 */
export interface RecordingSummary extends RecordingView {
  /** Where the original sits in the store. Admin-only, and never a URL. */
  readonly originalMediaKey: string;
  readonly createdAt: string;
}

/** Payload of `GET /api/v1/recordings`, as a member reads it. */
export interface RecordingListPayload {
  readonly recordings: readonly RecordingView[];
}

/** Payload of `GET /api/v1/recordings`, as the console reads it. */
export interface AdminRecordingListPayload {
  readonly recordings: readonly RecordingSummary[];
}

/**
 * Payload of `GET /api/v1/recordings/{id}`, as a member reads it.
 *
 * Wrapped rather than bare, matching the list — a payload that *is* the resource has nowhere to put
 * the second thing it will one day carry, and the list already made that choice.
 */
export interface RecordingPayload {
  readonly recording: RecordingView;
}

/**
 * Where a recording is made visible, and where it is taken back down
 * ([3.2.2](docs/project/prd.md), [3.2.11](docs/project/prd.md)).
 *
 * `POST` to a named sub-resource rather than a `PATCH` of the row, for the same reason
 * deactivation is a sub-resource of an account: what this does is not edit a recording.
 */
export function recordingPublishPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/publish`;
}

export function recordingUnpublishPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/unpublish`;
}

/** Where an approved summary is edited after publish ([3.6.11](docs/project/prd.md)). */
export function recordingSummaryPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/summary`;
}

/** Where a published summary is returned to draft ([3.6.12](docs/project/prd.md)). */
export function recordingSummaryUnpublishPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/summary/unpublish`;
}

/** Body of `PUT /api/v1/recordings/{id}/summary`. Plain text with line breaks. */
export interface EditSummaryRequest {
  readonly content: string;
}

/**
 * Payload of the four publish controls — the recording's gate and its summary's, as they now read.
 *
 * One shape for all four because a console pressing any of them wants the same answer: is this
 * live, and is its summary. Publishing an already-published recording answers with the timestamp
 * it already had, so pressing twice is harmless without the API inventing a conflict.
 */
export interface PublicationPayload {
  readonly id: string;
  /** ISO 8601, or `null`. */
  readonly publishedAt: string | null;
  /** ISO 8601 when the summary is published, `null` when it is a draft or does not exist. */
  readonly summaryPublishedAt: string | null;
}

/** `YYYY-MM-DD`, and a date the calendar actually has. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
