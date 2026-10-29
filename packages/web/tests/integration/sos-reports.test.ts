import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  ADMIN_REPORTS_PAGE_PATH,
  ANONYMOUS_DISPLAY_NAME,
  API_PREFIX,
  REPORTS_PATH,
  REPORT_REASONS,
  ROLE,
  SOS_PAGE_PATH,
  SOS_PATH,
  isApiErrorBody,
  reportResolvePath,
  sosPagePath,
  sosPath,
  sosRepliesPath,
  sosReplyPath,
  sosReportPath,
  sosReportResolvedTitle,
  sosReportedNotificationTitle,
  type NotificationListPayload,
  type RaiseSosRequest,
  type ReportListPayload,
  type ReportPayload,
  type ResolveReportPayload,
  type SosReportView,
  type SosSignalDetailView,
  type SosSignalPayload,
} from '@thp/shared';
import {
  createDatabase,
  findSosReportById,
  findSosSignalById,
  insertMemberBlock,
  type DatabaseHandle,
} from '@thp/db';
import { closeTestDatabase, createAccount, signIn, type TestAccount } from '../support/accounts';
import { readWholeInbox } from '../support/inbox';

/**
 * **Reporting on the SOS channel over the API** (Apple guideline 1.2, Google Play's UGC policy;
 * [3.16](docs/project/prd.md)) — `note-reports.test.ts`'s twin for a prayer request and the
 * replies on it, through the one route both take and the console queue both share with notes.
 *
 * Five claims:
 *
 * 1. **A report is a row and a notice**, on the request and on a reply alike: `201` with an id,
 *    every active admin told once with a press into the console, the reporter and the author not;
 *    a second press by the same member answers the first id with `200` and writes nothing.
 * 2. **The refusals are the service's.** Your own request or reply is `invalid_input`; a reply
 *    not on this request, a made-up one, and one by a member blocked either way are `not_found`;
 *    a reason off the list is `invalid_input`; a member cannot resolve anything.
 * 3. **The queue lists both kinds beside the notes**, oldest first, each saying what it is about,
 *    whose it is and what it reads now — and an anonymous request names nobody, an admin included.
 * 4. **Resolving is by subject.** Dismissing a reply's report closes every open report on that
 *    reply and tells each reporter it stays; removing deletes the reply, tells them it went, and
 *    the thread no longer carries it. A reply its author already removed is listed as removed
 *    and still resolves.
 * 5. **Removing a request** tells the reporters first and then takes the request, its replies and
 *    its reports with it: the page is gone and the report id resolves to nothing afterwards.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MADE_UP_ID = '00000000-0000-4000-8000-000000000000';

let handle: DatabaseHandle;

interface Signed extends TestAccount {
  readonly cookie: string;
}

let ana: Signed;
let ben: Signed;
let cara: Signed;
let admin: Signed;
let secondAdmin: Signed;

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

async function signedIn(role: 'admin' | 'member', label: string): Promise<Signed> {
  const account = await createAccount(databaseUrl, ROLE[role], `${label}-${RUN}`);
  const result = await signIn(baseUrl, account.email, account.password);
  if (result.cookie === null) throw new Error(`no cookie for ${account.email}`);
  return { ...account, cookie: result.cookie };
}

async function raised(
  who: Signed,
  description: string,
  extra: Partial<RaiseSosRequest> = {},
): Promise<SosSignalDetailView> {
  const answer = await call<SosSignalPayload>(SOS_PATH, {
    method: 'POST',
    cookie: who.cookie,
    body: { urgency: 'orange', description, ...extra },
  });
  if (answer.status !== 201) throw new Error(`raise refused ${answer.status}: ${answer.message}`);
  return answer.body.signal;
}

async function replied(who: Signed, signalId: string, text: string): Promise<string> {
  const answer = await call<SosSignalPayload>(sosRepliesPath(signalId), {
    method: 'POST',
    cookie: who.cookie,
    body: { text },
  });
  if (answer.status !== 201 && answer.status !== 200) {
    throw new Error(`reply refused ${answer.status}: ${answer.message}`);
  }
  const reply = answer.body.signal.replies.find((one) => one.text === text);
  if (reply === undefined) throw new Error('the reply was not listed back');
  return reply.id;
}

async function report(
  signalId: string,
  who: Signed,
  body: unknown = { reason: REPORT_REASONS[0] },
) {
  return call<ReportPayload>(sosReportPath(signalId), { method: 'POST', cookie: who.cookie, body });
}

async function queue(who: Signed) {
  return call<ReportListPayload>(REPORTS_PATH, { cookie: who.cookie });
}

function sosRows(payload: ReportListPayload, signalId: string): SosReportView[] {
  return payload.reports.filter(
    (one): one is SosReportView => one.kind !== 'note' && one.signalId === signalId,
  );
}

async function resolve(reportId: string, who: Signed, outcome: string) {
  return call<ResolveReportPayload>(reportResolvePath(reportId), {
    method: 'POST',
    cookie: who.cookie,
    body: { outcome },
  });
}

async function read(who: Signed, signalId: string) {
  return call<SosSignalPayload>(sosPath(signalId), { cookie: who.cookie });
}

/** This run's notices of one kind in somebody's centre. */
async function notices(who: Signed, kind: string): Promise<NotificationListPayload['notifications']> {
  return (await readWholeInbox(baseUrl, who.cookie)).notifications.filter((one) => one.kind === kind);
}

beforeAll(async () => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  [ana, ben, cara, admin, secondAdmin] = await Promise.all([
    signedIn('member', 'sos-report-ana'),
    signedIn('member', 'sos-report-ben'),
    signedIn('member', 'sos-report-cara'),
    signedIn('admin', 'sos-report-admin'),
    signedIn('admin', 'sos-report-admin-two'),
  ]);
}, 180_000);

afterAll(async () => {
  await handle?.close();
  await closeTestDatabase();
});

// =================================================================================================

describe('reporting a prayer request and a reply on it', () => {
  let signal: SosSignalDetailView;
  let bensReply: string;

  beforeAll(async () => {
    signal = await raised(ben, `Ben asks ${RUN}`);
    bensReply = await replied(ben, signal.id, `Ben adds ${RUN}`);
  }, 60_000);

  it('refuses an anonymous caller, and refuses a member the resolution', async () => {
    expect((await call(sosReportPath(signal.id), { method: 'POST' })).status).toBe(401);
    const closing = await resolve(MADE_UP_ID, ana, 'dismissed');
    expect(closing.status).toBe(403);
    expect(closing.code).toBe('forbidden');
  });

  it('refuses your own request and reply, a reason off the list, and a reply that is not there to you', async () => {
    const own = await report(signal.id, ben);
    expect(own.status).toBe(400);
    expect(own.code).toBe('invalid_input');
    expect(own.message).toContain('your own prayer request');

    const ownReply = await report(signal.id, ben, { reason: 'spam', replyId: bensReply });
    expect(ownReply.code).toBe('invalid_input');
    expect(ownReply.message).toContain('your own reply');

    expect((await report(signal.id, ana, { reason: 'rude' })).code).toBe('invalid_input');
    expect((await report(signal.id, ana, { reason: 'spam', detail: 'x'.repeat(501) })).code).toBe('invalid_input');
    expect((await report(signal.id, ana, { reason: 'spam', replyId: 'not-a-uuid' })).code).toBe('invalid_input');
    expect((await report(signal.id, ana, null)).code).toBe('invalid_input');

    expect((await report(MADE_UP_ID, ana)).code).toBe('not_found');
    expect((await report(signal.id, ana, { reason: 'spam', replyId: MADE_UP_ID })).code).toBe('not_found');

    // A reply on another request is not this request's.
    const other = await raised(cara, `Cara asks ${RUN}`);
    const carasReply = await replied(cara, other.id, `Cara adds ${RUN}`);
    expect((await report(signal.id, ana, { reason: 'spam', replyId: carasReply })).code).toBe('not_found');

    // A reply by somebody blocked either way is one the member cannot read, so there is nothing to report.
    const blocked = await signedIn('member', 'sos-report-blocked');
    const theirs = await replied(blocked, signal.id, `Blocked adds ${RUN}`);
    await insertMemberBlock(ana.id, blocked.id, handle);
    expect((await report(signal.id, ana, { reason: 'spam', replyId: theirs })).code).toBe('not_found');
    // And a request by them is hidden from the board and from the route alike.
    const hidden = await raised(blocked, `Hidden ${RUN}`);
    expect((await report(hidden.id, ana)).code).toBe('not_found');
  });

  it('takes a report on the request and on a reply, tells every other admin once, and repeats nothing', async () => {
    const adminBefore = (await notices(admin, 'sos_reported')).length;
    const secondBefore = (await notices(secondAdmin, 'sos_reported')).length;

    const first = await report(signal.id, ana, { reason: 'harassment', detail: '  Please look.  ' });
    expect(first.status).toBe(201);
    expect(first.body.reportId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await findSosReportById(first.body.reportId, handle);
    expect(row?.signalId).toBe(signal.id);
    expect(row?.aboutReply).toBe(false);
    expect(row?.replyId).toBeNull();
    expect(row?.reporterId).toBe(ana.id);
    expect(row?.reason).toBe('harassment');
    expect(row?.detail).toBe('Please look.');
    expect(row?.resolvedAt).toBeNull();

    // A second press by the same member is the first report, and writes nothing.
    const again = await report(signal.id, ana, { reason: 'spam' });
    expect(again.status).toBe(200);
    expect(again.body.reportId).toBe(first.body.reportId);

    // The reply is reported on the same terms, as its own subject.
    const onReply = await report(signal.id, cara, { reason: 'other', replyId: bensReply });
    expect(onReply.status).toBe(201);
    const replyRow = await findSosReportById(onReply.body.reportId, handle);
    expect(replyRow?.aboutReply).toBe(true);
    expect(replyRow?.replyId).toBe(bensReply);
    // Reporting the reply did not count as reporting the request: Cara can still report that.
    const carasOnRequest = await report(signal.id, cara, { reason: 'spam' });
    expect(carasOnRequest.status).toBe(201);

    // Every admin was told once per report, by the reporter's name, with a press into the console.
    const adminNow = await notices(admin, 'sos_reported');
    expect(adminNow.length).toBe(adminBefore + 3);
    expect(adminNow.some((one) => one.title === sosReportedNotificationTitle(ana.displayName))).toBe(true);
    expect(adminNow.some((one) => one.title === sosReportedNotificationTitle(cara.displayName))).toBe(true);
    expect(adminNow[0]?.href).toBe(ADMIN_REPORTS_PAGE_PATH);
    expect(adminNow[0]?.body).toMatch(/^Something else: |^Harassment or threats: |^Spam or advertising: /);
    expect((await notices(secondAdmin, 'sos_reported')).length).toBe(secondBefore + 3);
    // The reporter hears nothing of their own report, and the author is not told who reported them.
    expect((await notices(ana, 'sos_reported')).length).toBe(0);
    expect((await notices(ben, 'sos_reported')).length).toBe(0);
  });

  it('lists both kinds to an admin, oldest first, saying what each is about and whose it is', async () => {
    const list = await queue(admin);
    expect(list.status).toBe(200);
    const ours = sosRows(list.body, signal.id);
    expect(ours.map((one) => one.kind)).toEqual(['sos_signal', 'sos_reply', 'sos_signal']);

    const [onRequest, onReply] = ours;
    expect(onRequest?.reason).toBe('harassment');
    expect(onRequest?.detail).toBe('Please look.');
    expect(onRequest?.text).toBe(`Ben asks ${RUN}`);
    expect(onRequest?.deleted).toBe(false);
    expect(onRequest?.urgency).toBe('orange');
    expect(onRequest?.replyId).toBeNull();
    expect(onRequest?.authorDisplayName).toBe(ben.displayName);
    expect(onRequest?.reporterDisplayName).toBe(ana.displayName);
    expect(onReply?.replyId).toBe(bensReply);
    expect(onReply?.text).toBe(`Ben adds ${RUN}`);
    expect(onReply?.authorDisplayName).toBe(ben.displayName);
    expect(onReply?.reporterDisplayName).toBe(cara.displayName);
    // Nobody's address travels.
    expect(JSON.stringify(list.body)).not.toContain('@example.test');

    // The queue is one queue: a report's place in it is its moment, not its table.
    const ids = list.body.reports.map((one) => one.createdAt);
    expect([...ids].sort()).toEqual(ids);
  });

  it('names nobody on an anonymous request, even to an admin', async () => {
    const quiet = await raised(ben, `Quietly ${RUN}`, { anonymous: true });
    expect((await report(quiet.id, ana)).status).toBe(201);
    const listed = sosRows((await queue(admin)).body, quiet.id)[0];
    expect(listed?.authorDisplayName).toBe(ANONYMOUS_DISPLAY_NAME);
    expect(JSON.stringify(listed)).not.toContain(ben.displayName);
  });

  it('dismisses by reply: every open report on it closes, and each reporter is told it stays', async () => {
    // A second report on the same reply by a third member, so "by subject" has something to close.
    expect((await report(signal.id, ana, { reason: 'spam', replyId: bensReply })).status).toBe(201);
    const anaBefore = (await notices(ana, 'report_resolved')).length;
    const caraBefore = (await notices(cara, 'report_resolved')).length;

    const open = sosRows((await queue(admin)).body, signal.id).filter((one) => one.replyId === bensReply);
    expect(open).toHaveLength(2);

    const closed = await resolve(open[0]?.id ?? '', admin, 'dismissed');
    expect(closed.status).toBe(200);
    expect(closed.body.outcome).toBe('dismissed');
    expect(closed.body.closed).toBe(2);
    expect(sosRows(closed.body, signal.id).some((one) => one.replyId === bensReply)).toBe(false);
    // The request's own reports are untouched: a reply is its own subject.
    expect(sosRows(closed.body, signal.id).filter((one) => one.kind === 'sos_signal')).toHaveLength(2);

    // The reply is still there.
    const now = await read(ana, signal.id);
    expect(now.body.signal.replies.some((one) => one.id === bensReply)).toBe(true);

    // Each reporter heard once, with the sentence for a reply that stays, landing on the request.
    const anaNow = await notices(ana, 'report_resolved');
    expect(anaNow.length).toBe(anaBefore + 1);
    expect(anaNow[0]?.title).toBe(sosReportResolvedTitle('reply', 'dismissed'));
    expect(anaNow[0]?.href).toBe(sosPagePath(signal.id));
    expect((await notices(cara, 'report_resolved')).length).toBe(caraBefore + 1);

    // Resolving it again closes nothing and says what was decided.
    const again = await resolve(open[0]?.id ?? '', secondAdmin, 'removed');
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('dismissed');
    expect(again.body.closed).toBe(0);
    expect((await findSosReportById(open[0]?.id ?? '', handle))?.resolvedBy).toBe(admin.id);
  });

  it('removes a reply through moderation: it leaves the thread, and the reporter is told', async () => {
    const doomed = await replied(ben, signal.id, `Ben again ${RUN}`);
    const made = await report(signal.id, cara, { reason: 'hateful', replyId: doomed });
    expect(made.status).toBe(201);
    const caraBefore = (await notices(cara, 'report_resolved')).length;

    const removed = await resolve(made.body.reportId, admin, 'removed');
    expect(removed.status).toBe(200);
    expect(removed.body.outcome).toBe('removed');
    expect(removed.body.closed).toBe(1);

    const now = await read(ana, signal.id);
    expect(now.body.signal.replies.some((one) => one.id === doomed)).toBe(false);

    const caraNow = await notices(cara, 'report_resolved');
    expect(caraNow.length).toBe(caraBefore + 1);
    expect(caraNow[0]?.title).toBe(sosReportResolvedTitle('reply', 'removed'));
    expect(caraNow[0]?.href).toBe(sosPagePath(signal.id));

    expect((await resolve(MADE_UP_ID, admin, 'dismissed')).code).toBe('not_found');
    expect((await resolve(made.body.reportId, admin, 'ignored')).code).toBe('invalid_input');
  });

  it('lists a reply its author already removed as removed, and still resolves it', async () => {
    const fleeting = await replied(ben, signal.id, `Ben briefly ${RUN}`);
    const made = await report(signal.id, ana, { reason: 'spam', replyId: fleeting });
    expect(made.status).toBe(201);
    expect((await call(sosReplyPath(signal.id, fleeting), { method: 'DELETE', cookie: ben.cookie })).status).toBe(200);

    const listed = (await queue(admin)).body.reports.find((one) => one.id === made.body.reportId);
    if (listed?.kind !== 'sos_reply') throw new Error('the report on a reply was not listed as one');
    expect(listed.deleted).toBe(true);
    expect(listed.text).toBe('');
    expect(listed.replyId).toBeNull();

    const removed = await resolve(made.body.reportId, admin, 'removed');
    expect(removed.status).toBe(200);
    expect(removed.body.closed).toBe(1);
  });

  it('removes the request: the reporters are told, then the request and its reports go', async () => {
    const open = sosRows((await queue(admin)).body, signal.id).filter((one) => one.kind === 'sos_signal');
    expect(open).toHaveLength(2);

    const removed = await resolve(open[0]?.id ?? '', admin, 'removed');
    expect(removed.status).toBe(200);
    expect(removed.body.outcome).toBe('removed');
    expect(removed.body.closed).toBe(2);
    expect(sosRows(removed.body, signal.id)).toHaveLength(0);

    expect((await read(ana, signal.id)).code).toBe('not_found');
    // The request is a mark, not a delete (security audit 2026-10-29, finding 6): the report that
    // asked for the removal survives as the moderation record, resolved, and the row it is about
    // says who removed it and when.
    const kept = await findSosReportById(open[0]?.id ?? '', handle);
    expect(kept?.outcome).toBe('removed');
    expect(kept?.resolvedBy).toBe(admin.id);
    const marked = await findSosSignalById(signal.id, handle);
    expect(marked?.removedAt).not.toBeNull();
    expect(marked?.removedBy).toBe(admin.id);

    // The answer survived the cascade, and lands on the board rather than on a page that is gone.
    // The earlier answers about this request's replies named the request, so they went with it —
    // as every notice about a removed request does ([3.16.11](docs/project/prd.md)).
    const anaNow = await notices(ana, 'report_resolved');
    const answer = anaNow.find((one) => one.title === sosReportResolvedTitle('signal', 'removed'));
    expect(answer?.href).toBe(SOS_PAGE_PATH);
    expect(anaNow.some((one) => one.href === sosPagePath(signal.id))).toBe(false);
    expect((await notices(cara, 'report_resolved')).some((one) => one.href === SOS_PAGE_PATH)).toBe(true);

    // The report row survives the removal, resolved, so a second decision on it is read as the one
    // already taken rather than as a report that is gone.
    const again = await resolve(open[0]?.id ?? '', admin, 'dismissed');
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('removed');
    expect(again.body.closed).toBe(0);
  });
});
