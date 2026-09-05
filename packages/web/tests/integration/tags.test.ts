import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import {
  API_PREFIX,
  MAX_TAG_LENGTH,
  ROLE,
  SERIES_PATH,
  TAGS_PATH,
  memberRecordingPath,
  memberSeriesPath,
  recordingPath,
  recordingTagsPath,
  seriesPath,
  seriesTagsPath,
  tagPath,
  type DeleteTagPayload,
  type RecordingPayload,
  type SeriesListPayload,
  type SeriesPayload,
  type SeriesView,
  type TagListPayload,
  type TagPayload,
  type TagsPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, signedInAccount, type TestAccount } from '../support/accounts';

/**
 * **Tags over HTTP** ([4.7](docs/project/prd.md)) — the taxonomy and its two applications, driven
 * against the running server.
 *
 * Five claims:
 *
 * 1. **Every tag route refuses a member**, and the API is what refuses — not a screen.
 * 2. **A name has one spelling.** Whatever an admin types is lowercased and collapsed before it is
 *    compared, so `Grace` cannot be created beside `grace`, and the refusal is a `tag_exists`
 *    conflict the console can name.
 * 3. **Type-to-add is one request.** `PUT …/tags` with a name that is not yet a tag creates it and
 *    applies it, and the tags come back on the recording's and the series' own payloads — to the
 *    console and, once published, to a member.
 * 4. **Tagging changes nothing else.** The recording row is snapshotted straight out of the database
 *    before a set-replace-clear and compared afterwards.
 * 5. **Rename and delete reach every application**, and delete answers with what it took off.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let handle: DatabaseHandle;
let sql: postgres.Sql;
let adminCookie: string;
let memberCookie: string;
let member: TestAccount;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const body = (await response.json().catch(() => undefined)) as T & {
    error?: { code: string };
  };
  return { status: response.status, code: body?.error?.code ?? null, body };
}

/** A name unique to this run, in whatever spelling the test wants to send. */
function word(base: string): string {
  return `${base} ${RUN}`;
}

async function newRecording(title: string, published = false): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    { originalMediaKey: `originals/tags-api-${RUN}-${seeded}.mp3`, title, recordedAt: '2026-05-01' },
    handle,
  );
  if (published) await setRecordingPublication(row.id, new Date(), handle);
  return row.id;
}

async function createSeries(title: string): Promise<SeriesView> {
  const created = await call<{ series: SeriesView }>(SERIES_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ title, description: null }),
  });
  if (created.status !== 201) throw new Error(`create series refused: ${created.status}`);
  return created.body.series;
}

async function createTag(name: string): Promise<Answer<TagPayload>> {
  return call<TagPayload>(TAGS_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ name }),
  });
}

async function setRecordingTags(recordingId: string, names: readonly string[]): Promise<Answer<TagsPayload>> {
  return call<TagsPayload>(recordingTagsPath(recordingId), {
    method: 'PUT',
    cookie: adminCookie,
    body: JSON.stringify({ names }),
  });
}

async function setSeriesTags(seriesId: string, names: readonly string[]): Promise<Answer<TagsPayload>> {
  return call<TagsPayload>(seriesTagsPath(seriesId), {
    method: 'PUT',
    cookie: adminCookie,
    body: JSON.stringify({ names }),
  });
}

/** Every tag this run created, as the console reads them. */
async function ours(): Promise<TagListPayload['tags']> {
  const list = await call<TagListPayload>(TAGS_PATH, { cookie: adminCookie });
  return list.body.tags.filter((one) => one.name.endsWith(RUN.toLowerCase()));
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });

  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'tags-admin')).cookie;
  const asMember = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'tags-member');
  member = asMember.account;
  memberCookie = asMember.cookie;
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('the API refuses a member at every tag route', () => {
  it('answers forbidden — not not_found — to the list, the writes and both applications', async () => {
    const recordingId = await newRecording(`Refused ${RUN}`, true);
    const series = await createSeries(`Refused ${RUN}`);
    const created = await createTag(word('refused'));
    expect(created.status).toBe(201);

    const attempts: readonly [string, string, string | undefined][] = [
      [TAGS_PATH, 'GET', undefined],
      [TAGS_PATH, 'POST', JSON.stringify({ name: word('member-made') })],
      [tagPath(created.body.tag.id), 'PATCH', JSON.stringify({ name: word('member-renamed') })],
      [tagPath(created.body.tag.id), 'DELETE', undefined],
      [recordingTagsPath(recordingId), 'PUT', JSON.stringify({ names: [word('x')] })],
      [seriesTagsPath(series.id), 'PUT', JSON.stringify({ names: [word('x')] })],
    ];
    for (const [path, method, body] of attempts) {
      const refused = await call(path, {
        method,
        cookie: memberCookie,
        ...(body === undefined ? {} : { body }),
      });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.code, `${method} ${path}`).toBe('forbidden');
    }

    // Nothing was written: the tag still has its name, and nothing is on the recording or series.
    expect((await ours()).find((one) => one.id === created.body.tag.id)?.name).toBe(
      word('refused').toLowerCase(),
    );
    const detail = await call<RecordingPayload>(recordingPath(recordingId), { cookie: adminCookie });
    expect(detail.body.recording.tags).toEqual([]);
    expect(member.email).toContain('tags-member');
  });
});

describe('an admin creates a tag', () => {
  it('normalises the name and reads it back with both counts at zero', async () => {
    const created = await createTag(`  Grace   Notes ${RUN}  `);

    expect(created.status).toBe(201);
    expect(created.body.tag.name).toBe(`grace notes ${RUN}`.toLowerCase());
    expect(created.body.tag.recordingCount).toBe(0);
    expect(created.body.tag.seriesCount).toBe(0);

    const listed = (await ours()).find((one) => one.id === created.body.tag.id);
    expect(listed?.name).toBe(created.body.tag.name);
  });

  it('refuses a second spelling of an existing tag as tag_exists', async () => {
    const first = await createTag(word('mercy'));
    expect(first.status).toBe(201);

    for (const spelling of [word('mercy'), word('MERCY'), `  Mercy   ${RUN}`]) {
      const refused = await createTag(spelling);
      expect(refused.status, spelling).toBe(409);
      expect(refused.code, spelling).toBe('tag_exists');
    }
    expect((await ours()).filter((one) => one.name === word('mercy').toLowerCase())).toHaveLength(1);
  });

  it('refuses a blank, missing, malformed or over-long name before a row exists', async () => {
    const before = (await ours()).length;

    for (const body of [
      JSON.stringify({ name: '   ' }),
      JSON.stringify({}),
      JSON.stringify({ name: 42 }),
      JSON.stringify({ name: `${'x'.repeat(MAX_TAG_LENGTH + 1)}` }),
      'not json',
    ]) {
      const refused = await call(TAGS_PATH, { method: 'POST', cookie: adminCookie, body });
      expect(refused.status, body).toBe(400);
      expect(refused.code, body).toBe('invalid_input');
    }

    expect((await ours()).length).toBe(before);
  });

  it('lists every tag alphabetically', async () => {
    await createTag(word('zeal'));
    await createTag(word('faith'));
    const names = (await ours()).map((one) => one.name);
    expect(names).toEqual([...names].sort());
  });
});

describe('type-to-add on a recording', () => {
  it('creates the names that are new, applies the whole set, and answers alphabetically', async () => {
    const recordingId = await newRecording(`Typed ${RUN}`, true);
    await createTag(word('existing'));

    const set = await setRecordingTags(recordingId, [word('Existing'), word('brand new'), word('brand new'), '  ']);
    expect(set.status).toBe(200);
    expect(set.body.tags.map((one) => one.name)).toEqual(
      [word('brand new').toLowerCase(), word('existing').toLowerCase()].sort(),
    );

    // The new word is now a tag in its own right, on this one recording.
    const listed = (await ours()).find((one) => one.name === word('brand new').toLowerCase());
    expect(listed?.recordingCount).toBe(1);
    expect(listed?.seriesCount).toBe(0);

    // And the recording carries both, to the console and to a member.
    const asAdmin = await call<RecordingPayload>(recordingPath(recordingId), { cookie: adminCookie });
    expect(asAdmin.body.recording.tags).toEqual(set.body.tags);
    const asMember = await call<RecordingPayload>(memberRecordingPath(recordingId), {
      cookie: memberCookie,
    });
    expect(asMember.status).toBe(200);
    expect(asMember.body.recording.tags).toEqual(set.body.tags);
  });

  it('replaces the set and clears it, and never touches the recording row', async () => {
    const recordingId = await newRecording(`Snapshot ${RUN}`, true);
    const [before] = await sql`select * from recording where id = ${recordingId}`;

    await setRecordingTags(recordingId, [word('one'), word('two')]);
    const replaced = await setRecordingTags(recordingId, [word('two'), word('three')]);
    expect(replaced.body.tags.map((one) => one.name)).toEqual(
      [word('three').toLowerCase(), word('two').toLowerCase()].sort(),
    );
    const cleared = await setRecordingTags(recordingId, []);
    expect(cleared.body.tags).toEqual([]);

    const [after] = await sql`select * from recording where id = ${recordingId}`;
    expect(after).toEqual(before);

    // The tag that came off is still a tag — clearing a recording deletes nothing from the taxonomy.
    expect((await ours()).some((one) => one.name === word('one').toLowerCase())).toBe(true);
  });

  it('refuses a recording that does not exist and a body that is not a list of names', async () => {
    const nowhere = '00000000-0000-0000-0000-000000000000';
    const missing = await setRecordingTags(nowhere, [word('x')]);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not_found');

    const recordingId = await newRecording(`Bad body ${RUN}`);
    for (const body of [
      JSON.stringify({ names: 'grace' }),
      JSON.stringify({ names: [42] }),
      JSON.stringify({ names: ['x'.repeat(MAX_TAG_LENGTH + 1)] }),
      JSON.stringify({}),
    ]) {
      const refused = await call(recordingTagsPath(recordingId), {
        method: 'PUT',
        cookie: adminCookie,
        body,
      });
      expect(refused.status, body).toBe(400);
      expect(refused.code, body).toBe('invalid_input');
    }
  });

  it('keeps an unpublished teaching’s tags from a member along with the teaching', async () => {
    const recordingId = await newRecording(`Draft ${RUN}`);
    await setRecordingTags(recordingId, [word('draft-only')]);

    const refused = await call(memberRecordingPath(recordingId), { cookie: memberCookie });
    expect(refused.status).toBe(404);
    // The tag exists — an admin can see it counted — but no member surface names it anywhere.
    const listed = (await ours()).find((one) => one.name === word('draft-only').toLowerCase());
    expect(listed?.recordingCount).toBe(1);
  });
});

describe('type-to-add on a series', () => {
  it('tags the series itself, independently of the recordings in it', async () => {
    const series = await createSeries(`Study ${RUN}`);
    const recordingId = await newRecording(`In study ${RUN}`, true);
    await call(`/recordings/${recordingId}/series`, {
      method: 'PUT',
      cookie: adminCookie,
      body: JSON.stringify({ seriesId: series.id }),
    });

    const set = await setSeriesTags(series.id, [word('study-tag')]);
    expect(set.status).toBe(200);
    expect(set.body.tags.map((one) => one.name)).toEqual([word('study-tag').toLowerCase()]);

    // On the series, in the console list and on the member's page.
    const list = await call<SeriesListPayload>(SERIES_PATH, { cookie: adminCookie });
    expect(list.body.series.find((one) => one.id === series.id)?.tags).toEqual(set.body.tags);
    const asMember = await call<SeriesPayload>(memberSeriesPath(series.id), { cookie: memberCookie });
    expect(asMember.status).toBe(200);
    expect(asMember.body.series.tags).toEqual(set.body.tags);

    // Not on the recording in it.
    const detail = await call<RecordingPayload>(recordingPath(recordingId), { cookie: adminCookie });
    expect(detail.body.recording.tags).toEqual([]);

    // And a rename of the series carries the tags back on the answer.
    const renamed = await call<{ series: SeriesView }>(seriesPath(series.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ title: `Study renamed ${RUN}`, description: null }),
    });
    expect(renamed.body.series.tags).toEqual(set.body.tags);
  });

  it('refuses a series that does not exist', async () => {
    const missing = await setSeriesTags('00000000-0000-0000-0000-000000000000', [word('x')]);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not_found');
  });
});

describe('rename and delete reach every application', () => {
  it('renames a tag everywhere at once, and refuses a rename onto another tag', async () => {
    const recordingId = await newRecording(`Renamed ${RUN}`, true);
    const series = await createSeries(`Renamed ${RUN}`);
    await setRecordingTags(recordingId, [word('before')]);
    await setSeriesTags(series.id, [word('before')]);
    const tag = (await ours()).find((one) => one.name === word('before').toLowerCase());
    await createTag(word('taken'));

    const renamed = await call<TagPayload>(tagPath(tag!.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ name: `  After ${RUN} ` }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.tag.name).toBe(word('after').toLowerCase());
    expect(renamed.body.tag.recordingCount).toBe(1);
    expect(renamed.body.tag.seriesCount).toBe(1);

    const detail = await call<RecordingPayload>(recordingPath(recordingId), { cookie: adminCookie });
    expect(detail.body.recording.tags).toEqual([{ id: tag!.id, name: word('after').toLowerCase() }]);
    const study = await call<SeriesPayload>(seriesPath(series.id), { cookie: adminCookie });
    expect(study.body.series.tags).toEqual([{ id: tag!.id, name: word('after').toLowerCase() }]);

    const clash = await call(tagPath(tag!.id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ name: word('taken') }),
    });
    expect(clash.status).toBe(409);
    expect(clash.code).toBe('tag_exists');

    const missing = await call(tagPath('00000000-0000-0000-0000-000000000000'), {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ name: word('nowhere') }),
    });
    expect(missing.status).toBe(404);
  });

  it('deletes a tag from every recording and series, says how many, and touches nothing else', async () => {
    const recordingA = await newRecording(`Del A ${RUN}`, true);
    const recordingB = await newRecording(`Del B ${RUN}`, true);
    const series = await createSeries(`Del ${RUN}`);
    await setRecordingTags(recordingA, [word('doomed'), word('kept')]);
    await setRecordingTags(recordingB, [word('doomed')]);
    await setSeriesTags(series.id, [word('doomed')]);
    const doomed = (await ours()).find((one) => one.name === word('doomed').toLowerCase());
    const [before] = await sql`select * from recording where id = ${recordingA}`;

    const removed = await call<DeleteTagPayload>(tagPath(doomed!.id), {
      method: 'DELETE',
      cookie: adminCookie,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.name).toBe(word('doomed').toLowerCase());
    expect(removed.body.recordingCount).toBe(2);
    expect(removed.body.seriesCount).toBe(1);

    const detailA = await call<RecordingPayload>(recordingPath(recordingA), { cookie: adminCookie });
    expect(detailA.body.recording.tags.map((one) => one.name)).toEqual([word('kept').toLowerCase()]);
    const detailB = await call<RecordingPayload>(recordingPath(recordingB), { cookie: adminCookie });
    expect(detailB.body.recording.tags).toEqual([]);
    const study = await call<SeriesPayload>(seriesPath(series.id), { cookie: adminCookie });
    expect(study.body.series.tags).toEqual([]);

    const [after] = await sql`select * from recording where id = ${recordingA}`;
    expect(after).toEqual(before);
    expect((await ours()).some((one) => one.id === doomed!.id)).toBe(false);

    const again = await call(tagPath(doomed!.id), { method: 'DELETE', cookie: adminCookie });
    expect(again.status).toBe(404);
    expect(again.code).toBe('not_found');
  });
});
