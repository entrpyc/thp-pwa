import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  ROLE,
  recordingPlaybackPath,
  type PlaybackGrantPayload,
} from '@thp/shared';
import {
  createDatabase,
  insertRecording,
  setRecordingPublication,
  type DatabaseHandle,
} from '@thp/db';
import { walkFiles } from '../../../../tools/fs-walk';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **The signed `GET` a member listens through** (Story 4 Ticket 02).
 *
 * Three properties, and none of them is "the route returns a URL":
 *
 * 1. **The authorisation happens before anything is signed.** An unpublished teaching and an
 *    anonymous caller both leave with nothing they could replay.
 * 2. **The grant carries no object key**, so a client cannot name the object it was let at.
 * 3. **Minting is one function, and this route is its only caller** — the seam
 *    docs/epics/epic-core-listening/architecture.md § Extension points reserves for a processed
 *    rendition. That one is asserted against the source, because it is a claim about the shape of
 *    the codebase rather than about a response.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const settings = inject('mediaSettings');

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const WEB_SRC = resolve(REPO_ROOT, 'packages', 'web', 'src');

let handle: DatabaseHandle;
let memberCookie: string;
let adminCookie: string;
let publishedId: string;
let unpublishedId: string;
let seeded = 0;

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

async function newRecording(title: string): Promise<string> {
  seeded += 1;
  const row = await insertRecording(
    {
      originalMediaKey: `originals/playback-${RUN}-${seeded}.mp3`,
      title,
      recordedAt: '2026-08-16',
    },
    handle,
  );
  return row.id;
}

async function ask(
  recordingId: string,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${API_PREFIX}${recordingPlaybackPath(recordingId)}`, {
    headers: { accept: 'application/json', ...(cookie === undefined ? {} : { cookie }) },
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  memberCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'playback-member'))
    .cookie;
  adminCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'playback-admin')).cookie;

  publishedId = await newRecording(`Playback published ${RUN}`);
  unpublishedId = await newRecording(`Playback unpublished ${RUN}`);
  await setRecordingPublication(publishedId, new Date(), handle);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('a member gets a short-lived signed GET for a published teaching', () => {
  it('answers with a URL into the object store and its expiry', async () => {
    const { status, body } = await ask(publishedId, memberCookie);
    expect(status).toBe(200);

    const grant = body as PlaybackGrantPayload;
    const url = new URL(grant.url);
    expect(`${url.protocol}//${url.host}`).toBe(settings.MEDIA_ENDPOINT.replace(/\/+$/, ''));
    // The signature is on the wire, which is what makes "never publicly addressable" checkable
    // rather than asserted: the store enforces this, not us.
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(Number.isNaN(Date.parse(grant.expiresAt))).toBe(false);
  });

  it('expires one hour after issue', async () => {
    const { body } = await ask(publishedId, memberCookie);
    const grant = body as PlaybackGrantPayload;
    expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('3600');

    const minted = Date.parse(grant.expiresAt) - Date.now();
    expect(minted).toBeGreaterThan(55 * 60 * 1000);
    expect(minted).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  it('carries the URL and its expiry, and no key field beside them', async () => {
    const { body } = await ask(publishedId, memberCookie);
    // Two fields, exactly. The key is inside the signed URL because that is what a presigned URL
    // *is* — a path plus a signature over it — but it is never handed over as a value of its own,
    // so there is nothing for a client to hold on to once the signature has expired. The key as a
    // key lives in the log, where an operator tracing a failed listen needs it.
    expect(Object.keys(body as object).sort()).toEqual(['expiresAt', 'url']);
    expect(JSON.stringify(body)).not.toContain('"key"');
    expect(JSON.stringify(body)).not.toContain('originalMediaKey');
  });

  it('answers an admin the same way, because listening is not an operator act', async () => {
    const { status } = await ask(publishedId, adminCookie);
    expect(status).toBe(200);
  });
});

describe('nothing is signed for a teaching nobody published', () => {
  it('refuses an unpublished id, to a member and to an admin alike', async () => {
    // Whatever the role. The console is where unpublished rows live; a signed URL is a bearer token
    // for an object, and minting one for a teaching nobody published would outlive the refusal.
    const asMember = await ask(unpublishedId, memberCookie);
    expect(asMember.status).toBe(404);
    expect(JSON.stringify(asMember.body)).not.toContain('X-Amz-Signature');

    const asAdmin = await ask(unpublishedId, adminCookie);
    expect(asAdmin.status).toBe(404);
  });

  it('refuses a nonexistent id the same way', async () => {
    const nowhere = await ask('00000000-0000-0000-0000-000000000000', memberCookie);
    const unpublished = await ask(unpublishedId, memberCookie);
    expect(nowhere.status).toBe(unpublished.status);
    // Code and message, not the whole envelope: the correlation id differs per request by design,
    // and it discloses nothing about which ids exist.
    const refusal = (answer: unknown) => (answer as { error: { code: string; message: string } }).error;
    expect(refusal(nowhere.body).code).toBe(refusal(unpublished.body).code);
    expect(refusal(nowhere.body).message).toBe(refusal(unpublished.body).message);
  });

  it('refuses an anonymous caller and hands back nothing to replay', async () => {
    const { status, body } = await ask(publishedId);
    expect(status).toBe(401);
    expect((body as { error: { code: string } }).error.code).toBe('unauthenticated');
    expect(JSON.stringify(body)).not.toContain('X-Amz-');
  });
});

describe('signed-URL minting for playback is one function', () => {
  /** Every application source file, so this is a claim about the codebase and not about one path. */
  const sources = walkFiles(WEB_SRC).map((file) => ({
    path: file.split(/[\\/]/).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

  it('reads a substantial number of files — otherwise the check below is vacuous', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it('calls the media store`s presignGet in exactly one place', () => {
    // [§3.4](docs/project/prd.md) later makes playback prefer a processed rendition and fall back to
    // the original. That is a change to one function only if there is one of it — so a second
    // caller appearing is a failing test rather than something review has to notice.
    const callers = sources
      .filter((source) => /presignGet\s*\(/.test(source.text))
      .map((source) => source.path);
    expect(callers.map((path) => path.slice(path.indexOf('packages/web')))).toEqual([
      'packages/web/src/server/playback/grant.ts',
    ]);
  });

  it('has exactly one caller of the minting function, and it is the route', () => {
    const callers = sources
      .filter(
        (source) =>
          /mintPlaybackGrant\s*\(/.test(source.text) &&
          !source.path.endsWith('server/playback/grant.ts'),
      )
      .map((source) => source.path.slice(source.path.indexOf('packages/web')));
    expect(callers).toEqual([
      'packages/web/src/app/api/v1/recordings/[id]/playback/route.ts',
    ]);
  });
});
