import {
  findVisibleRecording,
  insertRecording,
  isUniqueViolation,
  listVisibleRecordings,
  withTransaction,
  type RecordingRow,
  type VisibleRecordingRow,
} from '@thp/db';
import {
  FIRST_PIPELINE_STEP,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  ACCEPTED_AUDIO_LABEL,
  LIBRARY_SURFACE,
  RECORDING_SURFACE_PARAM,
  describeBytes,
  isAcceptedAudioType,
  isCalendarDate,
  type CreateRecordingRequest,
  type RecordingSummary,
  type RecordingView,
  type UploadGrantPayload,
  type UploadGrantRequest,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import { can, type Actor } from '@/server/auth/policy';
import { queue } from '@/server/jobs/queue';
import { UPLOAD_GRANT_SECONDS, mediaStore, mintOriginalKey } from '@thp/media';
import { logger } from '@/server/observability/logger';

/**
 * Uploading a teaching, in two requests and one `PUT` that never touches this process.
 *
 * 1. **Grant** — the admin declares a size and a content type, and gets back a presigned `PUT`
 *    bound to a key we minted and to the type we signed for.
 * 2. **The browser `PUT`s the bytes straight to the store.** Nothing here sees them, in either
 *    direction (docs/epics/epic-core-listening/architecture.md § Media store).
 * 3. **Finalise** — the admin names the key, a title and the date recorded, and the row is written.
 *
 * The whole design turns on what step 3 is allowed to believe. The client's declared size in step 1
 * is a **convenience**: it fails an oversized file before a long upload rather than after one. The
 * authoritative check is the `HEAD` in step 3, against the store's own metadata — which is the only
 * thing "re-checked server-side" can mean when the API never sees the file. A client that lies in
 * step 1 gets a grant it cannot finalise.
 *
 * **A refusal never deletes the object.** There is nothing on the port to delete with
 * (), so a refused finalisation leaves an orphan in the bucket, invisible
 * because the list reads `recording` rows. That is the deliberate price of the one non-negotiable
 * (docs/project/prd.md, 3.4.9), and it is the cheap side of the trade.
 */

/** The most a field can be before we stop reading it. The same ceiling the account service uses. */
const MAX_FIELD_LENGTH = 512;

/**
 * A freshly written row, as the admin who wrote it reads it back.
 *
 * `summary` is always `null` here and the key is present anyway: what the API answers a creation
 * with has to be the same shape the list answers with, or a client would have two ideas of what a
 * recording is. A recording one request old has no approved summary by construction.
 */
export function describeRecording(row: RecordingRow): RecordingSummary {
  return {
    id: row.id,
    title: row.title,
    recordedAt: row.recordedAt,
    originalMediaKey: row.originalMediaKey,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    description: row.description,
    summary: null,
    // A recording one request old is in no series by construction — assignment is a later press on
    // the row this creation puts in the list.
    series: null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Mint the grant, or refuse before one exists.
 *
 * **Every refusal here happens before the store is asked for anything**, so a rejected format or an
 * oversized declaration costs a request and leaves no URL behind — which is the property the
 * refused-type criterion is actually about: not merely that the answer is an error, but that the
 * answer carries nothing a client could `PUT` with.
 */
export async function grantUpload(actor: Actor, body: unknown): Promise<UploadGrantPayload> {
  const requested = parseGrantRequest(body);

  const key = mintOriginalKey(requested.contentType);
  const expiresAt = new Date(Date.now() + UPLOAD_GRANT_SECONDS * 1000);
  const url = await mediaStore().presignPut({
    key,
    contentType: requested.contentType,
    expiresInSeconds: UPLOAD_GRANT_SECONDS,
  });

  logger.info('recording.upload.granted', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'recording.upload',
    target: `media:${key}`,
    // What the person chose it as, so an operator reading the log can tell which upload this was.
    // It is not what the key is built from — see `mintOriginalKey`.
    filename: requested.filename,
    contentType: requested.contentType,
    declaredSize: requested.size,
  });

  return { url, key, contentType: requested.contentType, expiresAt: expiresAt.toISOString() };
}

/**
 * Turn a finished upload into a recording.
 *
 * The order matters: the title and date are read first, so a malformed request is refused without
 * a round trip to the store; then the store is asked what is actually behind the key; then the row
 * is written, and **the unique index on `original_media_key` is what makes the second finalisation
 * of the same key fail**. A `select` here followed by an `insert` would have a window in which two
 * requests both find nothing.
 */
export async function finaliseUpload(actor: Actor, body: unknown): Promise<RecordingSummary> {
  const requested = parseCreateRequest(body);

  const stored = await mediaStore().head(requested.key);
  if (stored === null) {
    throw refuse(
      actor,
      requested.key,
      'nothing-at-key',
      'That upload did not finish. Choose the file again and re-upload it.',
    );
  }

  if (stored.size > MAX_UPLOAD_BYTES) {
    throw refuse(
      actor,
      requested.key,
      'over-ceiling',
      `The file that arrived is ${describeBytes(stored.size)}; the limit is ${MAX_UPLOAD_LABEL}.`,
    );
  }

  if (!isAcceptedAudioType(stored.contentType)) {
    throw refuse(
      actor,
      requested.key,
      'unaccepted-content-type',
      `The file that arrived is not audio this accepts. Upload ${ACCEPTED_AUDIO_LABEL}.`,
    );
  }

  let row: RecordingRow;
  let jobId: string;
  try {
    // **One transaction.** The row and the job that starts its pipeline land together, so there is
    // no state in which a recording exists and nothing will ever process it — which is the failure
    // class the ledger-is-the-queue choice exists to remove. An enqueue that fails takes the
    // recording with it, and the admin re-finalises the same key.
    const written = await withTransaction(async (tx) => {
      const created = await insertRecording(
        {
          originalMediaKey: requested.key,
          title: requested.title,
          recordedAt: requested.recordedAt,
        },
        tx,
      );
      // The first step comes off the ordered list, so §3.4 inserting a step ahead of `transcribe`
      // changes what an upload starts without an edit here. The correlation id is not passed: the
      // port reads the one this request is running under.
      const enqueued = await queue().enqueue(
        { recordingId: created.id, step: FIRST_PIPELINE_STEP },
        tx,
      );
      return { created, enqueued };
    });
    row = written.created;
    jobId = written.enqueued.id;
  } catch (cause) {
    if (!isUniqueViolation(cause)) throw cause;
    throw refuse(
      actor,
      requested.key,
      'already-finalised',
      'That upload is already a recording. It is in the list below.',
    );
  }

  logger.info('recording.create', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'recording.upload',
    target: `recording:${row.id}`,
    mediaKey: row.originalMediaKey,
    size: stored.size,
    contentType: stored.contentType,
    // The pipeline started itself (docs/project/prd.md 3.21.2.1). This line is where an operator
    // picks up the job id and follows it into the worker's log under the same correlation id.
    jobId,
    step: FIRST_PIPELINE_STEP,
  });

  return describeRecording(row);
}

/**
 * Which surface the caller says it is (Story 4 Ticket 01).
 *
 * `memberSurface: true` means "answer me the way you would answer a member", and it is a *request*
 * rather than a permission — it can only ever narrow what comes back, never widen it.
 */
export interface Surface {
  readonly memberSurface?: boolean;
}

/**
 * Whether this read answers the console's question or a member's.
 *
 * **Two conditions, and the member surface wins.** The role decides what a caller *may* see; the
 * surface decides what this screen is *for*. Without the second one, an admin opening the member
 * library would get the console's answer — unpublished rows and object keys, in a screen whose
 * whole job is to show what a member sees — and would have no way to check their own library
 * without signing out.
 */
function readsAsOperator(actor: Actor, surface: Surface): boolean {
  return surface.memberSurface === true ? false : can(actor, 'recording.list');
}

/** Read the surface off a request. The parameter is absent for every console call. */
export function surfaceOf(request: Request): Surface {
  const asked = new URL(request.url).searchParams.get(RECORDING_SURFACE_PARAM);
  return { memberSurface: asked === LIBRARY_SURFACE };
}

/**
 * **One route, one answer to "what may this person see"** (Story 3 Ticket 04).
 *
 * `GET /api/v1/recordings` is authorised by `recording.browse`, which both roles hold. What
 * separates the two answers is a second question asked here — whether the caller *also* satisfies
 * `recording.list`, the console's action — and that question decides exactly two things: whether
 * unpublished rows are included, and whether the object key and the creation time cross the wire.
 *
 * It is one route rather than two so Story 4 Ticket 01 builds its library on this and does not
 * invent a second answer. The condition itself is not written here: `listVisibleRecordings` owns
 * it, guarded, and this function passes it a boolean.
 */
export async function listRecordingsFor(
  actor: Actor,
  surface: Surface = {},
): Promise<RecordingView[]> {
  const asOperator = readsAsOperator(actor, surface);
  const rows = await listVisibleRecordings({ includeUnpublished: asOperator });

  logger.info('recording.browse', {
    actorId: actor.id,
    action: 'recording.browse',
    target: 'recording:*',
    count: rows.length,
    asOperator,
  });

  return rows.map((row) => (asOperator ? describeForOperator(row) : describeForMember(row)));
}

/**
 * **One recording, or a refusal** (Story 4 Ticket 01).
 *
 * The same shape as one row of the list and the same rule behind it: the caller's answer to
 * `recording.list` decides whether unpublished rows are reachable and whether the key and the
 * creation time cross the wire, and `findVisibleRecording` owns the condition itself.
 *
 * **An unpublished id and an id that never existed answer identically.** Both are `not_found`, so
 * the API does not report which ids exist — a member who guessed a uuid learns nothing from the
 * difference between "not yours to read" and "no such thing".
 */
export async function readRecordingFor(
  actor: Actor,
  id: string,
  surface: Surface = {},
): Promise<RecordingView> {
  const asOperator = readsAsOperator(actor, surface);
  const row = await findVisibleRecording(id, { includeUnpublished: asOperator });

  if (row === null) {
    logger.warn('recording.browse.refused', {
      actorId: actor.id,
      action: 'recording.browse',
      target: `recording:${id}`,
      reason: 'not-visible',
      code: 'not_found',
    });
    throw ApiError.notFound('There is no such teaching.');
  }

  logger.info('recording.browse', {
    actorId: actor.id,
    action: 'recording.browse',
    target: `recording:${row.id}`,
    asOperator,
  });

  return asOperator ? describeForOperator(row) : describeForMember(row);
}

/** Published, and nothing an operator would want that a listener has no business with. */
function describeForMember(row: VisibleRecordingRow): RecordingView {
  return {
    id: row.id,
    title: row.title,
    recordedAt: row.recordedAt,
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    description: row.description,
    summary: row.summary,
    // Both surfaces get it: the console's row renders its picker from it, and a member's row
    // renders the library's series label and the recording page's breadcrumb parent from it.
    series:
      row.seriesId === null || row.seriesTitle === null
        ? null
        : { id: row.seriesId, title: row.seriesTitle },
  };
}

/** The same, plus the two fields the console needs and a member never receives. */
function describeForOperator(row: VisibleRecordingRow): RecordingSummary {
  return {
    ...describeForMember(row),
    originalMediaKey: row.originalMediaKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One refusal, logged with actor, action and target under the request's correlation id, and thrown
 * as the single `upload_invalid` code. **The object stays where it is** — there is no delete to
 * call — so `reason` is the only record of why this key never became a recording.
 */
function refuse(actor: Actor, key: string, reason: string, message: string): ApiError {
  logger.warn('recording.refused', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'recording.upload',
    target: `media:${key}`,
    reason,
    code: 'upload_invalid',
  });
  return ApiError.uploadInvalid(message);
}


interface ParsedGrantRequest {
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

function parseGrantRequest(body: unknown): ParsedGrantRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a filename, a content type and a size.');
  }
  const { filename, contentType, size } = body as Partial<UploadGrantRequest>;

  if (typeof filename !== 'string' || filename.trim() === '' || filename.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the file you are uploading.');
  }
  if (typeof contentType !== 'string' || !isAcceptedAudioType(contentType)) {
    throw ApiError.invalidInput(`That is not audio this accepts. Upload ${ACCEPTED_AUDIO_LABEL}.`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw ApiError.invalidInput('Say how large the file is, in bytes.');
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw ApiError.invalidInput(
      `That file is ${describeBytes(size)}; the limit is ${MAX_UPLOAD_LABEL}.`,
    );
  }

  return { filename: filename.trim(), contentType: contentType.trim().toLowerCase(), size };
}

interface ParsedCreateRequest {
  readonly key: string;
  readonly title: string;
  readonly recordedAt: string;
}

function parseCreateRequest(body: unknown): ParsedCreateRequest {
  if (typeof body !== 'object' || body === null) {
    throw ApiError.invalidInput('Send a JSON object with a key, a title and the date recorded.');
  }
  const { key, title, recordedAt } = body as Partial<CreateRecordingRequest>;

  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Name the upload this recording is for.');
  }
  // Non-empty, and short enough that we are willing to read it. There is deliberately **no
  // title-length rule** beyond the generic field cap every route applies: the acceptance criteria
  // name the empty and absent cases and nothing else, and a maximum nobody asked for is a rule
  // somebody has to discover.
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_FIELD_LENGTH) {
    throw ApiError.invalidInput('Give the recording a title.');
  }
  // No upper bound on the date: nothing in docs/project/prd.md forbids a recording dated ahead, and
  // inventing that rule here would be a rule nobody asked for.
  if (!isCalendarDate(recordedAt)) {
    throw ApiError.invalidInput('Give the date it was recorded, as YYYY-MM-DD.');
  }

  return { key: key.trim(), title: title.trim(), recordedAt };
}
