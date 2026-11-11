import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ANNOUNCEMENTS_PATH,
  API_PREFIX,
  NOTIFICATIONS_PATH,
  RELEASE_NOTES_PAGE_PATH,
  RELEASE_NOTES_PATH,
  RELEASE_NOTE_IMAGE_UPLOADS_PATH,
  ROLE,
  releaseNotePagePath,
  releaseNotePath,
  releaseNoteSourcePath,
  type AnnouncementListPayload,
  type NotificationListPayload,
  type ReleaseNoteListPayload,
  type ReleaseNotePayload,
  type ReleaseNoteSourcePayload,
  type SaveReleaseNotePayload,
  type SendAnnouncementPayload,
  type UploadGrantPayload,
} from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';
import { webpBytes } from '../support/artwork';

/**
 * **Release notes over HTTP**, driven against the running server and the real bucket.
 *
 * Five claims:
 *
 * 1. **A member reads and an admin writes**, and the API is what refuses — every write route, the
 *    upload grant and the editor's own read answer a member `forbidden`.
 * 2. **A post is stored as its document.** What the editor sends comes back, normalised, on the
 *    post's own read and as an excerpt on the list; a body that is not a post is refused in words.
 * 3. **A picture is a key at rest and a URL in flight.** The grant → `PUT` → save path stores the
 *    key; a member's read carries a signed URL that fetches the bytes and never the key; the
 *    editor's read carries both. A key nothing was uploaded to is refused.
 * 4. **Edit rewrites, delete removes** — and an id that is not a post is `not_found` everywhere.
 * 5. **Deleting a post moves the notices that opened it** to the list rather than leaving a 404 in
 *    every bell, and the send that pointed at it stays listed with no post beside it.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let adminCookie: string;
let memberCookie: string;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => undefined)) as T & {
    error?: { code: string; message: string };
  };
  return {
    status: response.status,
    code: body?.error?.code ?? null,
    message: body?.error?.message ?? null,
    body,
  };
}

const paragraph = (words: string) => ({ type: 'paragraph', content: [{ type: 'text', text: words }] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

async function publish(title: string, body: unknown): Promise<string> {
  const saved = await call<SaveReleaseNotePayload>(RELEASE_NOTES_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: { title, body },
  });
  if (saved.status !== 201) throw new Error(`publish refused ${saved.status}: ${saved.message}`);
  return saved.body.releaseNote.id;
}

/** Grant and the real `PUT`, exactly as the editor makes them. Answers the key. */
async function uploaded(size = 2_048): Promise<string> {
  const grant = await call<UploadGrantPayload>(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
    method: 'POST',
    cookie: adminCookie,
    body: { filename: 'screen.webp', contentType: 'image/webp', size },
  });
  if (grant.status !== 200) throw new Error(`grant refused ${grant.status}: ${grant.message}`);
  expect(grant.body.key.startsWith('release-notes/')).toBe(true);
  const sent = await fetch(grant.body.url, {
    method: 'PUT',
    headers: { 'content-type': grant.body.contentType },
    body: webpBytes(size),
  });
  expect(sent.status).toBe(200);
  return grant.body.key;
}

beforeAll(async () => {
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, `rn-admin-${RUN}`)).cookie;
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, `rn-member-${RUN}`)).cookie;
});

afterAll(async () => {
  await closeTestDatabase();
});

describe('who may do what', () => {
  it('refuses a member every write, the upload grant and the editor’s read — forbidden', async () => {
    const id = await publish(`Gate ${RUN}`, doc(paragraph('x')));
    const body = { title: 'x', body: doc(paragraph('y')) };
    const attempts = await Promise.all([
      call(RELEASE_NOTES_PATH, { method: 'POST', cookie: memberCookie, body }),
      call(releaseNotePath(id), { method: 'PATCH', cookie: memberCookie, body }),
      call(releaseNotePath(id), { method: 'DELETE', cookie: memberCookie }),
      call(releaseNoteSourcePath(id), { cookie: memberCookie }),
      call(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
        method: 'POST',
        cookie: memberCookie,
        body: { filename: 'a.png', contentType: 'image/png', size: 10 },
      }),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe(403);
      expect(attempt.code).toBe('forbidden');
    }
    // And the post is still there, unchanged.
    const read = await call<ReleaseNotePayload>(releaseNotePath(id), { cookie: memberCookie });
    expect(read.body.releaseNote.title).toBe(`Gate ${RUN}`);
  });

  it('refuses everybody without a session', async () => {
    expect((await call(RELEASE_NOTES_PATH)).status).toBe(401);
  });
});

describe('a post', () => {
  it('is listed newest first with its excerpt, and read whole by a member', async () => {
    const older = await publish(`Older ${RUN}`, doc(paragraph('The first of its words.')));
    const newer = await publish(
      `  Newer ${RUN}  `,
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Highlights' }] },
        paragraph('You can now mark a moment.'),
        { type: 'youtube', attrs: { src: 'https://youtu.be/dQw4w9WgXcQ', width: 640, height: 360 } },
      ),
    );

    const list = await call<ReleaseNoteListPayload>(RELEASE_NOTES_PATH, { cookie: memberCookie });
    expect(list.status).toBe(200);
    const ids = list.body.releaseNotes.map((one) => one.id);
    expect(ids.indexOf(newer)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    const row = list.body.releaseNotes.find((one) => one.id === newer);
    expect(row?.title).toBe(`Newer ${RUN}`);
    expect(row?.excerpt).toBe('Highlights You can now mark a moment.');

    const read = await call<ReleaseNotePayload>(releaseNotePath(newer), { cookie: memberCookie });
    expect(read.status).toBe(200);
    expect(read.body.releaseNote.body.content).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Highlights' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'You can now mark a moment.' }] },
      { type: 'youtube', attrs: { videoId: 'dQw4w9WgXcQ' } },
    ]);
  });

  it('is refused, in words, when it is not one', async () => {
    const send = (body: unknown) =>
      call(RELEASE_NOTES_PATH, { method: 'POST', cookie: adminCookie, body });

    const untitled = await send({ title: '  ', body: doc(paragraph('x')) });
    expect(untitled.code).toBe('invalid_input');
    expect(untitled.message).toBe('Give the post a title.');

    const long = await send({ title: 'x'.repeat(121), body: doc(paragraph('x')) });
    expect(long.message).toContain('120');

    const empty = await send({ title: 'x', body: doc({ type: 'paragraph' }) });
    expect(empty.message).toBe('Write the post.');

    const script = await send({ title: 'x', body: doc({ type: 'script', content: [] }) });
    expect(script.code).toBe('invalid_input');
    expect(script.message).toContain('script');

    const link = await send({
      title: 'x',
      body: doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
      }),
    });
    expect(link.code).toBe('invalid_input');
  });

  it('is rewritten by an edit and gone after a delete; a missing one is not_found', async () => {
    const id = await publish(`Draft ${RUN}`, doc(paragraph('Before.')));

    const edited = await call<SaveReleaseNotePayload>(releaseNotePath(id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: { title: `Final ${RUN}`, body: doc(paragraph('After.')) },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.releaseNote.title).toBe(`Final ${RUN}`);
    expect(edited.body.releaseNote.excerpt).toBe('After.');
    expect(Date.parse(edited.body.releaseNote.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(edited.body.releaseNote.publishedAt),
    );

    const removed = await call(releaseNotePath(id), { method: 'DELETE', cookie: adminCookie });
    expect(removed.status).toBe(200);
    expect((await call(releaseNotePath(id), { cookie: memberCookie })).status).toBe(404);
    expect((await call(releaseNotePath(id), { method: 'DELETE', cookie: adminCookie })).status).toBe(404);
    expect(
      (
        await call(releaseNotePath(id), {
          method: 'PATCH',
          cookie: adminCookie,
          body: { title: 'x', body: doc(paragraph('y')) },
        })
      ).status,
    ).toBe(404);
    // Not a uuid at all: an absence, not a database error.
    expect((await call(releaseNotePath('not-an-id'), { cookie: memberCookie })).status).toBe(404);
  });
});

describe('a picture in a post', () => {
  it('is stored by key, read by a member as a signed URL, and by the editor as both', async () => {
    const key = await uploaded();
    const id = await publish(
      `Pictured ${RUN}`,
      doc(paragraph('Look:'), { type: 'image', attrs: { src: 'blob:local', key, alt: 'The new screen' } }),
    );

    const read = await call<ReleaseNotePayload>(releaseNotePath(id), { cookie: memberCookie });
    const image = read.body.releaseNote.body.content.find((one) => one.type === 'image');
    if (image?.type !== 'image') throw new Error('the post came back without its picture');
    expect(image.attrs.alt).toBe('The new screen');
    // No key as a field: the only place the object's name appears is inside the signed URL.
    expect(Object.keys(image.attrs).sort()).toEqual(['alt', 'src']);
    // The URL is a grant to the object itself.
    const fetched = await fetch(image.attrs.src);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/webp');

    const source = await call<ReleaseNoteSourcePayload>(releaseNoteSourcePath(id), {
      cookie: adminCookie,
    });
    const editable = source.body.releaseNote.body.content.find((one) => one.type === 'image');
    if (editable?.type !== 'image') throw new Error('the editor read came back without its picture');
    expect(editable.attrs.key).toBe(key);
    expect(editable.attrs.src).toMatch(/^https?:\/\//);

    // An edit that keeps the picture does not need it uploaded again.
    const kept = await call(releaseNotePath(id), {
      method: 'PATCH',
      cookie: adminCookie,
      body: { title: `Pictured ${RUN}`, body: source.body.releaseNote.body },
    });
    expect(kept.status).toBe(200);
  });

  it('is refused when nothing was uploaded behind its key, and when the grant is for no image', async () => {
    const ghost = await call(RELEASE_NOTES_PATH, {
      method: 'POST',
      cookie: adminCookie,
      body: {
        title: `Ghost ${RUN}`,
        body: doc({ type: 'image', attrs: { key: `release-notes/never-${RUN}.png` } }),
      },
    });
    expect(ghost.code).toBe('invalid_input');
    expect(ghost.message).toContain('did not finish uploading');

    const notImage = await call(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
      method: 'POST',
      cookie: adminCookie,
      body: { filename: 'a.svg', contentType: 'image/svg+xml', size: 100 },
    });
    expect(notImage.code).toBe('invalid_input');

    const gif = await call<UploadGrantPayload>(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
      method: 'POST',
      cookie: adminCookie,
      body: { filename: 'demo.gif', contentType: 'image/gif', size: 1_000 },
    });
    expect(gif.status).toBe(200);
    expect(gif.body.key).toMatch(/^release-notes\/.+\.gif$/);

    const huge = await call(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
      method: 'POST',
      cookie: adminCookie,
      body: { filename: 'big.gif', contentType: 'image/gif', size: 11 * 1024 * 1024 },
    });
    expect(huge.code).toBe('invalid_input');
  });
});

describe('deleting a post a notice opened', () => {
  it('moves those notices to the list, and keeps the send listed without its post', async () => {
    const title = `Announced ${RUN}`;
    const id = await publish(`Linked ${RUN}`, doc(paragraph('Read me.')));
    const sent = await call<SendAnnouncementPayload>(ANNOUNCEMENTS_PATH, {
      method: 'POST',
      cookie: adminCookie,
      body: { kind: 'new_feature', title, body: 'Something is new.', releaseNoteId: id },
    });
    expect(sent.status).toBe(201);

    const mine = async () => {
      const inbox = await call<NotificationListPayload>(NOTIFICATIONS_PATH, { cookie: memberCookie });
      return inbox.body.notifications.find((one) => one.title === title);
    };
    expect((await mine())?.href).toBe(releaseNotePagePath(id));

    expect((await call(releaseNotePath(id), { method: 'DELETE', cookie: adminCookie })).status).toBe(200);

    expect((await mine())?.href).toBe(RELEASE_NOTES_PAGE_PATH);
    const sends = await call<AnnouncementListPayload>(ANNOUNCEMENTS_PATH, { cookie: adminCookie });
    const kept = sends.body.announcements.find((one) => one.id === sent.body.announcement.id);
    expect(kept).toBeDefined();
    expect(kept?.releaseNoteId).toBeNull();
    expect(kept?.releaseNoteTitle).toBeNull();
  });
});
