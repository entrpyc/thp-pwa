import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  MAX_OPEN_SOS_PER_MEMBER,
  MAX_SOS_DESCRIPTION_LENGTH,
  NOTIFICATIONS_PATH,
  ROLE,
  SOS_PATH,
  SOS_STATUS_PARAM,
  isApiErrorBody,
  sosClosePath,
  sosPagePath,
  sosPath,
  sosPrayingPath,
  sosRaisedNotificationTitle,
  sosRepliesPath,
  sosReplyNotificationTitle,
  sosThreadReplyNotificationTitle,
  sosReplyPath,
  type NotificationListPayload,
  type NotificationView,
  type RaiseSosRequest,
  type SosListPayload,
  type SosSignalDetailView,
  type SosSignalPayload,
  type SosUrgency,
} from '@thp/shared';
import { createDatabase, insertMemberBlock, type DatabaseHandle } from '@thp/db';
import {
  closeTestDatabase,
  createAccount,
  signIn,
  type CreateAccountOptions,
  type TestAccount,
} from '../support/accounts';

/**
 * **The SOS channel over the API** ([3.16](docs/project/prd.md)), driven through the routes a
 * client would use.
 *
 * Seven claims:
 *
 * 1. **Raising** ([3.16.1](docs/project/prd.md)–[3.16.4](docs/project/prd.md)): a signal carries
 *    its colour and text and names its author; the board lists open signals most urgent then most
 *    recent first; a bad colour, an empty or over-long description and no session are refused.
 * 2. **Everybody is told** ([3.16.3](docs/project/prd.md), [3.17.7](docs/project/prd.md)) — but the
 *    author, and but a member blocked either way, who also cannot see the signal.
 * 3. **Praying** ([3.16.5](docs/project/prd.md)) is one row per member however often pressed, and
 *    is taken back with `DELETE`; the count and the names say so.
 * 4. **Replies** ([3.16.6](docs/project/prd.md), [3.16.7](docs/project/prd.md)) tell the author
 *    and nobody else; an author's own reply tells nobody; the author or an admin removes a reply,
 *    another member cannot.
 * 5. **Closing** ([3.16.8](docs/project/prd.md)–[3.16.10](docs/project/prd.md)): the author closes
 *    with a note, an admin without one, another member not at all; a closed signal moves to the
 *    resolved list and takes no more prayer or replies.
 * 6. **Removing** ([3.16.11](docs/project/prd.md)) is an admin's alone, and takes the bell entries
 *    with it.
 * 7. **The cap** ([3.16.12](docs/project/prd.md)) holds at `MAX_OPEN_SOS_PER_MEMBER` with
 *    `sos_limit`, and a signal and a reply are posts: terms acceptance gates both.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let admin: Signed;
let ana: Signed;
let ben: Signed;
let cara: Signed;

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly message: string;
  readonly body: T;
}

async function call<T>(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown },
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
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    code: isApiErrorBody(body) ? body.error.code : null,
    message: isApiErrorBody(body) ? body.error.message : '',
    body: body as T,
  };
}

async function signedIn(
  role: 'admin' | 'member',
  label: string,
  options: CreateAccountOptions = {},
): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`, undefined, options);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function raise(who: Signed, body: RaiseSosRequest | Record<string, unknown>) {
  return call<SosSignalPayload>(SOS_PATH, { method: 'POST', cookie: who.cookie, body });
}

async function raised(who: Signed, urgency: SosUrgency, description: string): Promise<SosSignalDetailView> {
  const answer = await raise(who, { urgency, description });
  if (answer.status !== 201) throw new Error(`raise refused ${answer.status}: ${answer.message}`);
  return answer.body.signal;
}

async function board(who: Signed, status: 'open' | 'resolved' = 'open'): Promise<SosListPayload> {
  const answer = await call<SosListPayload>(`${SOS_PATH}?${SOS_STATUS_PARAM}=${status}`, {
    cookie: who.cookie,
  });
  if (answer.status !== 200) throw new Error(`board refused ${answer.status}`);
  return answer.body;
}

async function read(who: Signed, id: string) {
  return call<SosSignalPayload>(sosPath(id), { cookie: who.cookie });
}

async function inbox(who: Signed): Promise<readonly NotificationView[]> {
  const answer = await call<NotificationListPayload>(NOTIFICATIONS_PATH, { cookie: who.cookie });
  if (answer.status !== 200) throw new Error(`inbox refused ${answer.status}`);
  return answer.body.notifications;
}

function about(notifications: readonly NotificationView[], signalId: string): NotificationView[] {
  return notifications.filter((one) => one.href === sosPagePath(signalId));
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 6 });
  admin = await signedIn('admin', 'sos-admin');
  ana = await signedIn('member', 'sos-ana');
  ben = await signedIn('member', 'sos-ben');
  cara = await signedIn('member', 'sos-cara');
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('raising a signal', () => {
  it('carries the colour, the text and the author, and the board lists most urgent then most recent first', async () => {
    const before = Date.now() - 1_000;
    const green = await raised(ana, 'green', `Green ${RUN}`);
    const red = await raised(ben, 'red', `Red ${RUN}`);
    const laterGreen = await raised(ana, 'green', `Later green ${RUN}`);

    expect(red.urgency).toBe('red');
    expect(red.description).toBe(`Red ${RUN}`);
    expect(red.author.displayName).toBe(ben.displayName);
    expect(red.author.id).toBe(ben.id);
    expect(red.mine).toBe(true);
    expect(red.closedAt).toBeNull();
    expect(red.prayingCount).toBe(0);
    expect(red.praying).toBe(false);
    expect(red.replies).toEqual([]);
    expect(new Date(red.raisedAt).getTime()).toBeGreaterThan(before);

    const open = await board(cara);
    const ids = open.signals.map((one) => one.id);
    const mine = ids.filter((id) => [green.id, red.id, laterGreen.id].includes(id));
    expect(mine).toEqual([red.id, laterGreen.id, green.id]);
    expect(open.openCounts.red).toBeGreaterThanOrEqual(1);
    expect(open.openCounts.green).toBeGreaterThanOrEqual(2);
    // Somebody else's signal is not "mine" to the reader.
    expect(open.signals.find((one) => one.id === red.id)?.mine).toBe(false);
  });

  it('refuses a colour that is not one of the four, an empty or over-long description, and no session', async () => {
    expect((await raise(ana, { urgency: 'purple', description: 'x' })).code).toBe('invalid_input');
    expect((await raise(ana, { urgency: 'red', description: '   ' })).code).toBe('invalid_input');
    expect(
      (await raise(ana, { urgency: 'red', description: 'x'.repeat(MAX_SOS_DESCRIPTION_LENGTH + 1) }))
        .code,
    ).toBe('invalid_input');
    expect((await raise(ana, 'not an object' as unknown as Record<string, unknown>)).code).toBe(
      'invalid_input',
    );
    expect((await call(SOS_PATH, {})).status).toBe(401);
    expect((await call(SOS_PATH, { method: 'POST', body: {} })).status).toBe(401);
    expect((await read(ana, MADE_UP_ID)).code).toBe('not_found');
  });

  it('tells everybody but the author, with the colour in the title and a press that lands on the signal', async () => {
    const signal = await raised(ana, 'orange', `Told ${RUN}`);

    const bens = about(await inbox(ben), signal.id);
    expect(bens).toHaveLength(1);
    expect(bens[0]?.kind).toBe('sos_raised');
    expect(bens[0]?.title).toBe(sosRaisedNotificationTitle(ana.displayName, 'orange'));
    expect(bens[0]?.body).toBe(`Told ${RUN}`);
    expect(about(await inbox(admin), signal.id)).toHaveLength(1);
    expect(about(await inbox(ana), signal.id)).toHaveLength(0);
  });
});

describe('praying', () => {
  it('is one row however often pressed, names the member, and is taken back', async () => {
    const signal = await raised(ana, 'yellow', `Pray ${RUN}`);

    const once = await call<SosSignalPayload>(sosPrayingPath(signal.id), { method: 'PUT', cookie: ben.cookie });
    expect(once.status).toBe(200);
    expect(once.body.signal.prayingCount).toBe(1);
    expect(once.body.signal.praying).toBe(true);
    expect(once.body.signal.prayingNames).toEqual([ben.displayName]);

    const twice = await call<SosSignalPayload>(sosPrayingPath(signal.id), { method: 'PUT', cookie: ben.cookie });
    expect(twice.body.signal.prayingCount).toBe(1);

    await call(sosPrayingPath(signal.id), { method: 'PUT', cookie: cara.cookie });
    const seen = await read(ana, signal.id);
    expect(seen.body.signal.prayingCount).toBe(2);
    expect(seen.body.signal.praying).toBe(false);
    expect(seen.body.signal.prayingNames).toEqual([ben.displayName, cara.displayName]);

    const back = await call<SosSignalPayload>(sosPrayingPath(signal.id), { method: 'DELETE', cookie: ben.cookie });
    expect(back.body.signal.prayingCount).toBe(1);
    expect(back.body.signal.praying).toBe(false);
    // Taking back what was never given is the state the member asked for.
    expect((await call(sosPrayingPath(signal.id), { method: 'DELETE', cookie: ben.cookie })).status).toBe(200);
    expect((await call(sosPrayingPath(MADE_UP_ID), { method: 'PUT', cookie: ben.cookie })).code).toBe('not_found');
  });
});

describe('replies', () => {
  it('tell the author and nobody else, read oldest first, and are removed by their author or an admin', async () => {
    const signal = await raised(ana, 'yellow', `Reply ${RUN}`);

    const first = await call<SosSignalPayload>(sosRepliesPath(signal.id), {
      method: 'POST',
      cookie: ben.cookie,
      body: { text: `Praying, Ana ${RUN}` },
    });
    expect(first.status).toBe(201);
    expect(first.body.signal.replies.map((one) => one.text)).toEqual([`Praying, Ana ${RUN}`]);
    expect(first.body.signal.replies[0]?.author.displayName).toBe(ben.displayName);
    expect(first.body.signal.replies[0]?.mine).toBe(true);
    expect(first.body.signal.replyCount).toBe(1);

    const second = await call<SosSignalPayload>(sosRepliesPath(signal.id), {
      method: 'POST',
      cookie: cara.cookie,
      body: { text: `Psalm 23 ${RUN}` },
    });
    expect(second.body.signal.replies.map((one) => one.text)).toEqual([
      `Praying, Ana ${RUN}`,
      `Psalm 23 ${RUN}`,
    ]);

    // The author replying to their own signal tells nobody.
    await call(sosRepliesPath(signal.id), { method: 'POST', cookie: ana.cookie, body: { text: 'Thank you both' } });

    const anas = about(await inbox(ana), signal.id).filter((one) => one.kind === 'sos_reply');
    expect(anas.map((one) => one.title).sort()).toEqual(
      [sosReplyNotificationTitle(ben.displayName), sosReplyNotificationTitle(cara.displayName)].sort(),
    );
    expect(about(await inbox(ben), signal.id).filter((one) => one.kind === 'sos_reply')).toHaveLength(0);

    const bensReply = second.body.signal.replies[0]!;
    const carasReply = second.body.signal.replies[1]!;
    expect((await call(sosReplyPath(signal.id, bensReply.id), { method: 'DELETE', cookie: cara.cookie })).code).toBe('forbidden');
    const own = await call<SosSignalPayload>(sosReplyPath(signal.id, bensReply.id), { method: 'DELETE', cookie: ben.cookie });
    expect(own.status).toBe(200);
    expect(own.body.signal.replies.some((one) => one.id === bensReply.id)).toBe(false);
    const moderated = await call<SosSignalPayload>(sosReplyPath(signal.id, carasReply.id), { method: 'DELETE', cookie: admin.cookie });
    expect(moderated.status).toBe(200);
    expect(moderated.body.signal.replies.map((one) => one.text)).toEqual(['Thank you both']);
    expect((await call(sosReplyPath(signal.id, carasReply.id), { method: 'DELETE', cookie: admin.cookie })).code).toBe('not_found');

    expect((await call(sosRepliesPath(signal.id), { method: 'POST', cookie: ben.cookie, body: { text: '' } })).code).toBe('invalid_input');
  });

  it('thread one level deep under a top-level reply, tell the thread`s author, and go with the reply they answer', async () => {
    const signal = await raised(ana, 'green', `Thread ${RUN}`);

    const top = await call<SosSignalPayload>(sosRepliesPath(signal.id), {
      method: 'POST',
      cookie: ben.cookie,
      body: { text: `Praying ${RUN}` },
    });
    const bensReply = top.body.signal.replies[0]!;

    // Cara answers Ben inside his thread.
    const answered = await call<SosSignalPayload>(sosRepliesPath(signal.id), {
      method: 'POST',
      cookie: cara.cookie,
      body: { text: `Me too ${RUN}`, parentId: bensReply.id },
    });
    expect(answered.status).toBe(201);
    expect(answered.body.signal.replies).toHaveLength(1);
    expect(answered.body.signal.replies[0]?.replies.map((one) => one.text)).toEqual([`Me too ${RUN}`]);
    expect(answered.body.signal.replyCount).toBe(2);
    const carasAnswer = answered.body.signal.replies[0]!.replies[0]!;

    // Answering the answer attaches to the thread's top, so threads stay one level deep.
    const deeper = await call<SosSignalPayload>(sosRepliesPath(signal.id), {
      method: 'POST',
      cookie: ana.cookie,
      body: { text: `Thank you ${RUN}`, parentId: carasAnswer.id },
    });
    expect(deeper.body.signal.replies).toHaveLength(1);
    expect(deeper.body.signal.replies[0]?.replies.map((one) => one.text)).toEqual([
      `Me too ${RUN}`,
      `Thank you ${RUN}`,
    ]);

    // Ben is told of Cara's answer in his thread and of Ana's; Ana, the author, is told of both replies by others.
    const bens = about(await inbox(ben), signal.id).filter((one) => one.kind === 'sos_reply');
    expect(bens.map((one) => one.title).sort()).toEqual(
      [sosThreadReplyNotificationTitle(cara.displayName), sosThreadReplyNotificationTitle(ana.displayName)].sort(),
    );
    const anas = about(await inbox(ana), signal.id).filter((one) => one.kind === 'sos_reply');
    expect(anas.map((one) => one.title).sort()).toEqual(
      [sosReplyNotificationTitle(ben.displayName), sosReplyNotificationTitle(cara.displayName)].sort(),
    );

    // A parent that is not this signal's reply, or not a reply at all, is refused.
    const other = await raised(cara, 'green', `Other ${RUN}`);
    expect((await call(sosRepliesPath(other.id), { method: 'POST', cookie: ben.cookie, body: { text: 'x', parentId: bensReply.id } })).code).toBe('invalid_input');
    expect((await call(sosRepliesPath(signal.id), { method: 'POST', cookie: ben.cookie, body: { text: 'x', parentId: 'nope' } })).code).toBe('invalid_input');

    // Removing the top-level reply takes its thread with it.
    const removed = await call<SosSignalPayload>(sosReplyPath(signal.id, bensReply.id), { method: 'DELETE', cookie: ben.cookie });
    expect(removed.status).toBe(200);
    expect(removed.body.signal.replies).toEqual([]);
    expect(removed.body.signal.replyCount).toBe(0);
  });
});

describe('closing', () => {
  it('is the author`s with a note, an admin`s without one, and nobody else`s; a closed signal is resolved and quiet', async () => {
    const signal = await raised(ana, 'red', `Close ${RUN}`);

    expect((await call(sosClosePath(signal.id), { method: 'POST', cookie: ben.cookie, body: {} })).code).toBe('forbidden');

    const closed = await call<SosSignalPayload>(sosClosePath(signal.id), {
      method: 'POST',
      cookie: ana.cookie,
      body: { note: `All well now ${RUN}` },
    });
    expect(closed.status).toBe(200);
    expect(closed.body.signal.closedAt).not.toBeNull();
    expect(closed.body.signal.closingNote).toBe(`All well now ${RUN}`);

    expect((await board(ben)).signals.some((one) => one.id === signal.id)).toBe(false);
    const resolved = await board(ben, 'resolved');
    expect(resolved.signals.some((one) => one.id === signal.id)).toBe(true);
    expect(resolved.status).toBe('resolved');

    expect((await call(sosClosePath(signal.id), { method: 'POST', cookie: ana.cookie, body: {} })).code).toBe('invalid_input');
    expect((await call(sosPrayingPath(signal.id), { method: 'PUT', cookie: ben.cookie })).code).toBe('invalid_input');
    expect((await call(sosRepliesPath(signal.id), { method: 'POST', cookie: ben.cookie, body: { text: 'late' } })).code).toBe('invalid_input');

    const other = await raised(ben, 'green', `Admin closes ${RUN}`);
    expect((await call(sosClosePath(other.id), { method: 'POST', cookie: admin.cookie, body: { note: 'no' } })).code).toBe('invalid_input');
    const byAdmin = await call<SosSignalPayload>(sosClosePath(other.id), { method: 'POST', cookie: admin.cookie, body: {} });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.signal.closedAt).not.toBeNull();
    expect(byAdmin.body.signal.closingNote).toBeNull();
    expect((await call(`${SOS_PATH}?${SOS_STATUS_PARAM}=everything`, { cookie: ben.cookie })).code).toBe('invalid_input');
  });
});

describe('removing', () => {
  it('is an admin`s alone, and takes the bell entries with the signal', async () => {
    const signal = await raised(ana, 'orange', `Remove ${RUN}`);
    await call(sosRepliesPath(signal.id), { method: 'POST', cookie: ben.cookie, body: { text: 'here' } });
    expect(about(await inbox(ben), signal.id)).toHaveLength(1);
    expect(about(await inbox(ana), signal.id)).toHaveLength(1);

    expect((await call(sosPath(signal.id), { method: 'DELETE', cookie: ana.cookie })).code).toBe('forbidden');
    const gone = await call<{ signalId: string }>(sosPath(signal.id), { method: 'DELETE', cookie: admin.cookie });
    expect(gone.status).toBe(200);
    expect(gone.body.signalId).toBe(signal.id);

    expect((await read(ben, signal.id)).code).toBe('not_found');
    expect((await call(sosPath(signal.id), { method: 'DELETE', cookie: admin.cookie })).code).toBe('not_found');
    expect(about(await inbox(ben), signal.id)).toHaveLength(0);
    expect(about(await inbox(ana), signal.id)).toHaveLength(0);
  });
});

describe('blocks, the cap and the terms', () => {
  it('hides a signal from a member blocked either way and tells them nothing', async () => {
    const blocker = await signedIn('member', 'sos-blocker');
    const blocked = await signedIn('member', 'sos-blocked');
    await insertMemberBlock(blocker.id, blocked.id, handle);

    const signal = await raised(blocked, 'red', `Hidden ${RUN}`);
    expect((await read(blocker, signal.id)).code).toBe('not_found');
    expect((await board(blocker)).signals.some((one) => one.id === signal.id)).toBe(false);
    expect(about(await inbox(blocker), signal.id)).toHaveLength(0);
    expect(about(await inbox(ben), signal.id)).toHaveLength(1);
    expect((await call(sosRepliesPath(signal.id), { method: 'POST', cookie: blocker.cookie, body: { text: 'x' } })).code).toBe('not_found');
  });

  it('refuses the eleventh open signal with sos_limit, and takes one again once one is closed', async () => {
    const busy = await signedIn('member', 'sos-busy');
    const ids: string[] = [];
    for (let index = 0; index < MAX_OPEN_SOS_PER_MEMBER; index += 1) {
      ids.push((await raised(busy, 'green', `Cap ${index} ${RUN}`)).id);
    }
    const eleventh = await raise(busy, { urgency: 'green', description: 'one more' });
    expect(eleventh.status).toBe(409);
    expect(eleventh.code).toBe('sos_limit');

    await call(sosClosePath(ids[0]!), { method: 'POST', cookie: busy.cookie, body: {} });
    expect((await raise(busy, { urgency: 'green', description: 'one more' })).status).toBe(201);
  }, 120_000);

  it('gates a signal and a reply on current terms acceptance', async () => {
    const newcomer = await signedIn('member', 'sos-newcomer', { termsAccepted: false });
    expect((await raise(newcomer, { urgency: 'green', description: 'please' })).code).toBe('terms_required');
    const signal = await raised(ana, 'green', `Terms ${RUN}`);
    expect((await call(sosRepliesPath(signal.id), { method: 'POST', cookie: newcomer.cookie, body: { text: 'x' } })).code).toBe('terms_required');
    // Praying is a press, not a post.
    expect((await call(sosPrayingPath(signal.id), { method: 'PUT', cookie: newcomer.cookie })).status).toBe(200);
  });
});
