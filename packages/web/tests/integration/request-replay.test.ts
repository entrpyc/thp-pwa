import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  FLOW_QUESTION_BANK_PATH,
  IDEMPOTENCY_KEY_HEADER,
  ROLE,
  SOS_PATH,
  type FlowQuestionBankPayload,
  type SosListPayload,
  type SosSignalPayload,
} from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';

/**
 * **A write the device may send twice applies once** ([3.18.19](docs/project/prd.md)) — and the
 * one read that lets a Flow Tracker session start offline ([3.18.18](docs/project/prd.md)).
 *
 * A request queued offline is replayed with a key the device minted. If the answer to the first
 * send is lost, the device sends it again; the route wrapper answers the second from the first's
 * receipt without running the handler. Driven here on the write where a second application is
 * most visible: raising a prayer request.
 */

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let cookie: string;
let otherCookie: string;

async function call(path: string, init: { method?: string; cookie: string; body?: unknown; key?: string }) {
  const response = await fetch(`${baseUrl}${API_PREFIX}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie: init.cookie,
      ...(init.key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: init.key }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown };
}

async function openWith(description: string, who: string): Promise<number> {
  const list = (await call(`${SOS_PATH}?status=open`, { cookie: who })).body as SosListPayload;
  return list.signals.filter((one) => one.description === description).length;
}

beforeAll(async () => {
  cookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, `replay-${RUN}`)).cookie;
  otherCookie = (await signedInAccount(baseUrl, databaseUrl, ROLE.member, `replay-other-${RUN}`)).cookie;
});

afterAll(async () => {
  await closeTestDatabase();
});

describe('a replayed write', () => {
  it('is answered the second time with the first answer, and applied once', async () => {
    const key = crypto.randomUUID();
    const description = `Raised once ${RUN}`;
    const body = { urgency: 'green', description, anonymous: false };

    const first = await call(SOS_PATH, { method: 'POST', cookie, body, key });
    expect(first.status).toBe(201);
    const second = await call(SOS_PATH, { method: 'POST', cookie, body, key });
    expect(second.status).toBe(201);
    expect((second.body as SosSignalPayload).signal.id).toBe((first.body as SosSignalPayload).signal.id);
    expect(await openWith(description, cookie)).toBe(1);
  });

  it('is applied again without a key, or under a different one — the key is what makes it one write', async () => {
    const description = `Raised twice ${RUN}`;
    const body = { urgency: 'green', description, anonymous: false };
    await call(SOS_PATH, { method: 'POST', cookie, body, key: crypto.randomUUID() });
    await call(SOS_PATH, { method: 'POST', cookie, body, key: crypto.randomUUID() });
    expect(await openWith(description, cookie)).toBe(2);
  });

  it('keeps a key to the member who used it: the same key from somebody else is their own write', async () => {
    const key = crypto.randomUUID();
    const mine = `Mine under a shared key ${RUN}`;
    const theirs = `Theirs under a shared key ${RUN}`;
    const first = await call(SOS_PATH, { method: 'POST', cookie, body: { urgency: 'green', description: mine }, key });
    const second = await call(SOS_PATH, { method: 'POST', cookie: otherCookie, body: { urgency: 'green', description: theirs }, key });
    expect((second.body as SosSignalPayload).signal.id).not.toBe((first.body as SosSignalPayload).signal.id);
    expect((second.body as SosSignalPayload).signal.description).toBe(theirs);
  });

  it('keeps no receipt for a refusal, so the same key can be tried again once the request is right', async () => {
    const key = crypto.randomUUID();
    const refused = await call(SOS_PATH, { method: 'POST', cookie, body: { urgency: 'green', description: '   ' }, key });
    expect(refused.status).toBe(400);
    const description = `Right the second time ${RUN}`;
    const accepted = await call(SOS_PATH, { method: 'POST', cookie, body: { urgency: 'green', description }, key });
    expect(accepted.status).toBe(201);
    expect(await openWith(description, cookie)).toBe(1);
  });

  it('ignores a key that is not the shape a device mints', async () => {
    const description = `Loose key ${RUN}`;
    const body = { urgency: 'green', description };
    await call(SOS_PATH, { method: 'POST', cookie, body, key: 'not-a-uuid' });
    await call(SOS_PATH, { method: 'POST', cookie, body, key: 'not-a-uuid' });
    expect(await openWith(description, cookie)).toBe(2);
  });
});

describe('what a Flow Tracker session would ask', () => {
  it('is readable by a member, as two maps of questions, and refused without a session', async () => {
    const answer = await call(FLOW_QUESTION_BANK_PATH, { cookie });
    expect(answer.status).toBe(200);
    const bank = answer.body as FlowQuestionBankPayload;
    expect(typeof bank.byTeaching).toBe('object');
    expect(typeof bank.byTag).toBe('object');
    for (const seeds of Object.values(bank.byTeaching)) {
      for (const seed of seeds) expect(typeof seed.question).toBe('string');
    }
    expect((await fetch(`${baseUrl}${API_PREFIX}${FLOW_QUESTION_BANK_PATH}`)).status).toBe(401);
  });
});
