import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  REVIEW_FIELD,
  ROLE,
  recordingScripturePath,
  reviewPath,
  type RecordingScripturePayload,
  type ReviewListPayload,
} from '@thp/shared';
import {
  createDatabase,
  findScriptureReferences,
  insertRecording,
  replaceOpenDrafts,
  setRecordingPublication,
  type DatabaseHandle,
  type ReviewItemRow,
} from '@thp/db';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **Where in the recording a passage is cited** ([3.7.10](docs/project/prd.md)) — the anchor,
 * through the review gate that writes it and the read that answers with it.
 *
 * The requirement is short and has three halves, and each is a way the anchor can be wrong:
 *
 * 1. It is **carried**, from what the machine proposed through the approval to the stored reference
 *    and out to the reader — because a value that survives four hops and not the fifth is a value
 *    nobody can rely on.
 * 2. It is **optional**, and the empty case is the ordinary one: a reference an admin added by hand,
 *    or one the transcript gave no position for, "carries none and belongs to the recording rather
 *    than to any chapter".
 * 3. It is **admin-editable**, which means an admin can correct where the machine placed a passage
 *    and can clear one it placed wrongly — and that doing either is recorded as an edit
 *    ([4.17.5](docs/project/prd.md)).
 *
 * What it *unblocks* — scoping a chapter's scripture tab — is asserted in `chapters.test.ts`, where
 * there are chapters to scope to.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const FIELD = REVIEW_FIELD.scripture.name;
const MINUTE = 60_000;

/** One placed by the machine, and one it could not place. Both are ordinary answers (3.7.10). */
const PROPOSED = [
  { book: 'john', chapter: 15, verseStart: 1, verseEnd: 2, anchorMs: 5 * MINUTE },
  { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4, anchorMs: null },
];

const PROVENANCE = {
  model: 'fake',
  modelVersion: 'fake-1',
  promptVersion: 'draft-1',
  steeringPrompt: null,
  fields: { [FIELD]: { aiSuggested: true, editedByAdmin: false } },
};

let handle: DatabaseHandle;
let adminCookie: string;
let memberCookie: string;
let seeded = 0;

interface Answer<T> {
  readonly status: number;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Answer<T>> {
  const { cookie, ...rest } = init;
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    ...rest,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...rest.headers,
    },
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as T };
}

/** A published teaching carrying an open scripture draft with the anchors above on it. */
async function drafted(
  citations: readonly unknown[] = PROPOSED,
): Promise<{ recordingId: string; item: ReviewItemRow }> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/anchor-${seeded}-${Date.now().toString(36)}.mp3`,
      title: `Anchor ${seeded} ${Date.now().toString(36)}`,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  await setRecordingPublication(row.id, new Date(), handle);

  const [item] = await replaceOpenDrafts(
    row.id,
    [{ kind: 'scripture', fields: { [FIELD]: citations }, provenance: PROVENANCE }],
    handle,
  );
  return { recordingId: row.id, item: item as ReviewItemRow };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'anchor-admin')).cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'anchor-member')).cookie;
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

describe('the anchor, carried through the gate (3.7.10)', () => {
  it('reaches the admin on the draft, so they can see where the machine placed it', async () => {
    const { recordingId } = await drafted();
    const queue = await call<ReviewListPayload>('/reviews', { cookie: adminCookie });

    const item = queue.body.reviews.find((one) => one.recordingId === recordingId);
    const citations = item?.fields[FIELD] as readonly { book: string; anchorMs: number | null }[];
    // Admin-editable means admin-visible first: a reviewer who cannot see the anchor cannot correct
    // it, and one who cannot correct it is reviewing half the proposal.
    expect(citations.find((one) => one.book === 'john')?.anchorMs).toBe(5 * MINUTE);
    expect(citations.find((one) => one.book === 'romans')?.anchorMs).toBeNull();
  });

  it('is stored when the machine’s list is approved as it stands', async () => {
    const { recordingId, item } = await drafted();
    const approved = await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(approved.status).toBe(200);

    const rows = await findScriptureReferences(recordingId, handle);
    const anchors = new Map(rows.map((one) => [one.book, one.anchorMs]));
    expect(anchors.get('john')).toBe(5 * MINUTE);
    // Optional, and the null is the design: this reference belongs to the recording rather than to
    // any chapter.
    expect(anchors.get('romans')).toBeNull();
  });

  it('reaches the member on the published teaching’s references', async () => {
    const { recordingId, item } = await drafted();
    await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ action: 'approve' }),
    });

    const read = await call<RecordingScripturePayload>(recordingScripturePath(recordingId), {
      cookie: memberCookie,
    });

    const anchors = new Map(read.body.references.map((one) => [one.book, one.anchorMs]));
    expect(anchors.get('john')).toBe(5 * MINUTE);
    expect(anchors.get('romans')).toBeNull();
  });
});

describe('the anchor, corrected by an admin (3.7.10, 4.17.5)', () => {
  it('takes the admin’s anchor where the machine’s was wrong, and records the edit', async () => {
    const { recordingId, item } = await drafted();

    await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        action: 'approve',
        fields: {
          [FIELD]: [
            // The same passage, moved: `from` names the proposal it replaces.
            { book: 'john', chapter: 15, verseStart: 1, verseEnd: 2, anchorMs: 9 * MINUTE, from: 0 },
            { book: 'romans', chapter: 8, verseStart: 1, verseEnd: 4, anchorMs: null, from: 1 },
          ],
        },
      }),
    });

    const rows = await findScriptureReferences(recordingId, handle);
    const john = rows.find((one) => one.book === 'john');
    expect(john?.anchorMs).toBe(9 * MINUTE);
    // Moving where a passage was placed is editing the reference as much as changing a verse number
    // is — both are the admin correcting what the machine proposed.
    expect(john?.editedByAdmin).toBe(true);
    // And the one they left alone is not marked as edited.
    expect(rows.find((one) => one.book === 'romans')?.editedByAdmin).toBe(false);
  });

  it('clears an anchor the admin removed, which is a legal state rather than a refusal', async () => {
    const { recordingId, item } = await drafted();

    const answer = await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        action: 'approve',
        fields: {
          [FIELD]: [
            { book: 'john', chapter: 15, verseStart: 1, verseEnd: 2, anchorMs: null, from: 0 },
          ],
        },
      }),
    });

    expect(answer.status).toBe(200);
    const rows = await findScriptureReferences(recordingId, handle);
    expect(rows[0]?.anchorMs).toBeNull();
    expect(rows[0]?.editedByAdmin).toBe(true);
  });

  /**
   * **A reference an admin added by hand carries none** unless they said otherwise — nothing invents
   * one, which is the half of 3.7.10 that is a promise rather than a capability.
   */
  it('gives a reference an admin added no anchor of its own', async () => {
    const { recordingId, item } = await drafted();

    await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        action: 'approve',
        fields: {
          [FIELD]: [{ book: 'psalm', chapter: 23, verseStart: 1, verseEnd: 6, from: null }],
        },
      }),
    });

    const rows = await findScriptureReferences(recordingId, handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe('person');
    expect(rows[0]?.anchorMs).toBeNull();
  });

  /**
   * **An anchor that is not an offset is dropped, and the citation stands.** Losing a passage over
   * the convenience on top of it would be the wrong trade in exactly the direction 3.7.4 warns
   * about.
   */
  it('drops a nonsense anchor rather than refusing the passage it was on', async () => {
    const { recordingId, item } = await drafted();

    const answer = await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({
        action: 'approve',
        fields: {
          [FIELD]: [
            { book: 'john', chapter: 15, verseStart: 1, verseEnd: 2, anchorMs: -5, from: 0 },
          ],
        },
      }),
    });

    expect(answer.status).toBe(200);
    const rows = await findScriptureReferences(recordingId, handle);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.book).toBe('john');
    expect(rows[0]?.anchorMs).toBeNull();
  });
});

/**
 * **A draft written before anchors existed still approves.** The widening cost nothing precisely
 * because a missing anchor and an unplaceable passage read the same — as a reference belonging to
 * the recording rather than to any chapter.
 */
describe('a draft from before the anchor existed', () => {
  it('approves, and its references simply carry no anchor', async () => {
    const { recordingId, item } = await drafted([
      { book: 'john', chapter: 15, verseStart: 1, verseEnd: 2 },
    ]);

    const answer = await call(reviewPath(item.id), {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ action: 'approve' }),
    });

    expect(answer.status).toBe(200);
    const rows = await findScriptureReferences(recordingId, handle);
    expect(rows[0]?.anchorMs).toBeNull();
    expect(rows[0]?.editedByAdmin).toBe(false);
  });
});
