/**
 * The recording wire contract, and the two rules an upload has to satisfy.
 *
 * Read by the API, by the admin upload screen and by the media store, so none of the three can
 * invent its own idea of what is acceptable. The size ceiling and the accepted formats are
 * **operator decisions** recorded in
 * docs/epics/epic-core-listening/architecture.md § Key choices, "Two inputs this epic needs and
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
 * A recording as an admin is allowed to see it.
 *
 * `publishedAt` and `description` are here and are always `null` in this ticket: the columns exist
 * because the payload an admin reads is the row, and nothing writes either until Story 3.
 */
export interface RecordingSummary {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly recordedAt: string;
  /** Where the original sits in the store. Admin-only, and never a URL. */
  readonly originalMediaKey: string;
  /** ISO 8601, or `null` while unpublished. Nothing in this ticket writes it. */
  readonly publishedAt: string | null;
  /** Generated in Story 3. Nothing in this ticket writes it. */
  readonly description: string | null;
  readonly createdAt: string;
}

/** Payload of `GET /api/v1/recordings`. */
export interface RecordingListPayload {
  readonly recordings: readonly RecordingSummary[];
}

/** `YYYY-MM-DD`, and a date the calendar actually has. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
