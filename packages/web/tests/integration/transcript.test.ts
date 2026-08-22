import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  ROLE,
  isApiErrorBody,
  recordingTranscriptPath,
  type TranscriptPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  replaceTranscript,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **The transcript read** (Story 5 Ticket 01) — [3.5.3](docs/project/prd.md).
 *
 * The first place a member touches the segment model Story 2 wrote. What is asserted here is the
 * shape of the answer and the gate in front of it: the whole transcript in one response, in
 * playback order, with the corrected-by columns left behind — and an unpublished id answered
 * exactly as a made-up one is, so the API does not report which ids exist.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

/** A deliberate gap between the third and fourth lines, and one line the machine misheard. */
const SEGMENTS = [
  { startMs: 0, endMs: 4120, text: 'Good morning, and welcome to this teaching.', speaker: 0 },
  { startMs: 4120, endMs: 9880, text: 'We are picking up where we left off.', speaker: 0 },
  { startMs: 9880, endMs: 15_340, text: 'Before we read, a word about why this matters.', speaker: 1 },
  // the gap: 15_340 → 18_000
  { startMs: 18_000, endMs: 24_500, text: 'Turn with me to the second chapter.', speaker: 0 },
] as const;

let handle: DatabaseHandle;
let memberCookie: string;
let adminCookie: string;
let publishedId: string;
let unpublishedId: string;
let noTranscriptId: string;

const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';

async function recordingWith(
  title: string,
  options: { published: boolean; transcript: boolean },
): Promise<string> {
  const row = await insertRecording(
    {
      originalMediaKey: `originals/${title.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2)}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  if (options.transcript) {
    await replaceTranscript(
      { recordingId: row.id, language: 'en', confidence: 0.94, segments: SEGMENTS },
      handle,
    );
  }
  if (options.published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function get(recordingId: string, cookie: string) {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingTranscriptPath(recordingId)}`, {
    headers: { accept: 'application/json', cookie },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'transcript-member'))
    .cookie;
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'transcript-admin')).cookie;

  const run = Date.now().toString(36);
  publishedId = await recordingWith(`Transcript live ${run}`, {
    published: true,
    transcript: true,
  });
  unpublishedId = await recordingWith(`Transcript hidden ${run}`, {
    published: false,
    transcript: true,
  });
  noTranscriptId = await recordingWith(`Transcript none ${run}`, {
    published: true,
    transcript: false,
  });
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member reads the transcript of a published teaching', () => {
  it('answers the whole transcript in one response, in playback order', async () => {
    const { status, body } = await get(publishedId, memberCookie);
    expect(status).toBe(200);

    const { transcript } = body as TranscriptPayload;
    expect(transcript).not.toBeNull();
    expect(transcript?.language).toBe('en');
    expect(transcript?.segments).toHaveLength(SEGMENTS.length);

    // The query's order, by `(transcript_id, start_ms)` — so the screen and the database give one
    // answer to what order a transcript is in.
    expect(transcript?.segments.map((one) => one.text)).toEqual(SEGMENTS.map((one) => one.text));
    const starts = transcript?.segments.map((one) => one.startMs) ?? [];
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('carries the five fields a reader needs and neither corrected-by column', async () => {
    const { body } = await get(publishedId, memberCookie);
    const first = (body as TranscriptPayload).transcript?.segments[0];

    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual(['endMs', 'id', 'speaker', 'startMs', 'text']);
    expect(first?.startMs).toBe(SEGMENTS[0].startMs);
    expect(first?.endMs).toBe(SEGMENTS[0].endMs);
    expect(first?.speaker).toBe(0);

    // Who fixed a line is not a member's business, however the payload is built.
    expect(JSON.stringify(body)).not.toContain('correctedAt');
    expect(JSON.stringify(body)).not.toContain('correctedByUserId');
  });

  it('answers a published teaching with no transcript rather than failing', async () => {
    const { status, body } = await get(noTranscriptId, memberCookie);
    expect(status).toBe(200);
    // `null`, not an error: the tab renders an empty state, and the page still works.
    expect((body as TranscriptPayload).transcript).toBeNull();
  });
});

describe('an unpublished id and a nonexistent id are refused identically', () => {
  it('answers not_found for both, with the same message', async () => {
    const hidden = await get(unpublishedId, memberCookie);
    const imaginary = await get(MADE_UP_ID, memberCookie);

    expect(hidden.status).toBe(404);
    expect(imaginary.status).toBe(404);
    if (!isApiErrorBody(hidden.body) || !isApiErrorBody(imaginary.body)) {
      throw new Error('expected error envelopes');
    }
    expect(hidden.body.error.code).toBe('not_found');
    // Indistinguishable, so a member who guessed a uuid learns nothing from the difference between
    // "not yours to read" and "no such thing".
    expect(hidden.body.error.code).toBe(imaginary.body.error.code);
    expect(hidden.body.error.message).toBe(imaginary.body.error.message);
  });

  it('refuses an admin the unpublished transcript too — correction is published-only', async () => {
    // There is no `?surface=` parameter on this route and no admin path into it. Epic flow B's
    // pre-publish correction is satisfied by correcting after publish, per flow D.
    const hidden = await get(unpublishedId, adminCookie);
    expect(hidden.status).toBe(404);
    // And the same admin reads the published one perfectly well, so this is the gate and not a
    // broken cookie.
    expect((await get(publishedId, adminCookie)).status).toBe(200);
  });

  it('refuses an anonymous caller before it says anything about the id', async () => {
    const response = await fetch(
      `${baseUrl}${API_PREFIX}${recordingTranscriptPath(publishedId)}`,
      { headers: { accept: 'application/json' } },
    );
    expect(response.status).toBe(401);
    const body: unknown = await response.json();
    if (!isApiErrorBody(body)) throw new Error('expected an error envelope');
    expect(body.error.code).toBe('unauthenticated');
  });
});
