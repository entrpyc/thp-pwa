import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import {
  API_PREFIX,
  FEEDBACK_PATH,
  MAX_FEEDBACK_DESCRIPTION_LENGTH,
  MAX_FEEDBACK_TITLE_LENGTH,
  ROLE,
  feedbackKindLabel,
  isApiErrorBody,
  type FeedbackSubmittedPayload,
} from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';
import { mailOffset, waitForMail, type CapturedMail } from '../support/mail';

/**
 * **Reporting a bug, driven over HTTP against the running server.**
 *
 * Nothing is stored, so there is no row to assert against and the message *is* the assertion. Every
 * test below therefore reads the capture file the primary server writes instead of a database — the
 * report we actually composed, rather than a mock of the code that composes it.
 *
 * Two properties shape the file, and neither can be checked by importing a function:
 *
 * 1. **The reporter is the session and never the body.** A request that names somebody else is
 *    answered with a message naming the account that sent it, which is what stops this route from
 *    being a way to send mail as another member.
 * 2. **A send failure reaches the member.** Everything else in this product writes its row first and
 *    can retry from it; this cannot, so a failure reported as success would lose the report in
 *    silence. That needs a server whose transport genuinely refuses — `mailDownBaseUrl` is one.
 */

const baseUrl = inject('apiBaseUrl');
const mailDownBaseUrl = inject('mailDownBaseUrl');
const databaseUrl = inject('databaseUrl');
const mailPath = inject('mailCapturePath');

const FEEDBACK_URL = `${baseUrl}${API_PREFIX}${FEEDBACK_PATH}`;
const MAIL_DOWN_URL = `${mailDownBaseUrl}${API_PREFIX}${FEEDBACK_PATH}`;

/**
 * Where a report goes when nothing has said otherwise.
 *
 * The suite sets no `FEEDBACK_MAIL_TO`, which is the case that matters: the default is the whole
 * reason that variable is optional, and a deployment that never sets one still has to deliver.
 */
const DEFAULT_RECIPIENT = 'indepthwebsolutions@gmail.com';

interface Answer<T> {
  readonly status: number;
  readonly code: string | null;
  readonly body: T;
}

async function submit<T>(
  url: string,
  cookie: string,
  body: unknown,
): Promise<Answer<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  return {
    status: response.status,
    code: isApiErrorBody(parsed) ? parsed.error.code : null,
    body: parsed as T,
  };
}

/** The one message this call produced, waited for — the send happens inside a request we have left. */
async function sentAfter(offset: number, title: string): Promise<CapturedMail> {
  const messages = await waitForMail(mailPath, offset, (all) =>
    all.some((one) => one.subject.includes(title)),
  );
  const found = messages.find((one) => one.subject.includes(title));
  if (found === undefined) {
    throw new Error(`no message carrying "${title}" was captured`);
  }
  return found;
}

let member: { account: { email: string; displayName: string }; cookie: string };
let admin: { account: { email: string; displayName: string }; cookie: string };

beforeAll(async () => {
  // The labels become the addresses, and one assertion below is that no message names a role — so
  // neither label may contain one, or the account's own address would fail it.
  member = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'reporter');
  admin = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'maintainer');
});

afterAll(async () => {
  await closeTestDatabase();
});

describe('a member sends a bug report', () => {
  it('mails it to the maintainer and answers that it was sent', async () => {
    const title = `player stops on refresh ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    const answer = await submit<FeedbackSubmittedPayload>(FEEDBACK_URL, member.cookie, {
      kind: 'bug',
      title,
      description: 'I press play, refresh the page, and it starts from the beginning again.',
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ submitted: true });

    const message = await sentAfter(offset, title);
    expect(message.to).toBe(DEFAULT_RECIPIENT);
    // The kind is the prefix, so a subject truncated in a notification still says which arrived.
    expect(message.subject).toBe(`${feedbackKindLabel('bug')}: ${title}`);
  });

  it('names the account that sent it, in both parts of the message', async () => {
    const title = `who sent this ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    await submit(FEEDBACK_URL, member.cookie, {
      kind: 'bug',
      title,
      description: 'Whoever reads this should be able to write back.',
    });

    const message = await sentAfter(offset, title);
    for (const part of [message.text, message.html]) {
      expect(part).toContain(member.account.email);
      expect(part).toContain(member.account.displayName);
    }
  });

  it('says nothing about the reporter beyond their name and address', async () => {
    const title = `no role in here ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    await submit(FEEDBACK_URL, admin.cookie, {
      kind: 'bug',
      title,
      // The words this report is checked for must not be in the report itself, or it would fail
      // itself rather than fail the rule.
      description: 'Sent from the console, and the message should not say who by.',
    });

    const message = await sentAfter(offset, title);
    // Nothing outside the policy module touches `actor.role`, so nothing here could have put one in
    // the message — this is that rule, checked against what actually went out rather than against
    // the source. An admin's report reads exactly like a member's.
    for (const part of [message.text, message.html]) {
      expect(part).not.toContain(ROLE.admin);
      expect(part).not.toContain(ROLE.member);
    }
  });

  it('carries the whole report in the plain-text part', async () => {
    const title = `text part ${Date.now().toString(36)}`;
    const description = 'Step one.\nStep two.\nThen it stops.';
    const offset = mailOffset(mailPath);

    await submit(FEEDBACK_URL, member.cookie, { kind: 'bug', title, description });

    const message = await sentAfter(offset, title);
    // Deliberately the text part: it is what a notification preview and a text client read, and a
    // report only present inside the HTML table layout is a report somebody triaging on a phone
    // cannot act on. The member's own line breaks are still in it.
    expect(message.text).toContain(description);
    expect(message.text).toContain(title);
  });

  it('takes feedback on the same terms, labelled as feedback', async () => {
    const title = `an idea ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    const answer = await submit<FeedbackSubmittedPayload>(FEEDBACK_URL, member.cookie, {
      kind: 'feedback',
      title,
      description: 'The library would read better grouped by series.',
    });

    expect(answer.status).toBe(200);
    const message = await sentAfter(offset, title);
    expect(message.subject).toBe(`${feedbackKindLabel('feedback')}: ${title}`);
  });

  it('lets an admin report on exactly the same terms', async () => {
    const title = `console report ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    const answer = await submit<FeedbackSubmittedPayload>(FEEDBACK_URL, admin.cookie, {
      kind: 'bug',
      title,
      description: 'The pipeline panel shows a step twice.',
    });

    expect(answer.status).toBe(200);
    const message = await sentAfter(offset, title);
    expect(message.text).toContain(admin.account.email);
  });
});

describe('the reporter is the session, not the body', () => {
  it('ignores a "from" the caller put in the body and names the signed-in account', async () => {
    const title = `impersonation attempt ${Date.now().toString(36)}`;
    const offset = mailOffset(mailPath);

    await submit(FEEDBACK_URL, member.cookie, {
      kind: 'bug',
      title,
      description: 'Sent with extra fields the wire contract does not have.',
      from: 'someone-else@example.test',
      reporterEmail: 'someone-else@example.test',
      to: 'attacker@example.test',
    });

    const message = await sentAfter(offset, title);
    // The recipient is configuration and the sender is the session. Neither is reachable from the
    // body, which is why a relay is not what this route is.
    expect(message.to).toBe(DEFAULT_RECIPIENT);
    expect(message.text).toContain(member.account.email);
    expect(message.text).not.toContain('someone-else@example.test');
    expect(message.html).not.toContain('someone-else@example.test');
  });
});

describe('what it refuses', () => {
  it('refuses an anonymous caller', async () => {
    const response = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bug', title: 'no session', description: 'no session' }),
    });
    const body: unknown = await response.json().catch(() => undefined);

    expect(response.status).toBe(401);
    expect(isApiErrorBody(body) ? body.error.code : null).toBe('unauthenticated');
  });

  it.each([
    ['no kind', { title: 'a title', description: 'a description' }],
    ['a kind that is neither', { kind: 'question', title: 'a title', description: 'a body' }],
    ['an empty title', { kind: 'bug', title: '   ', description: 'a description' }],
    ['an empty description', { kind: 'bug', title: 'a title', description: '   ' }],
    ['a title that is not text', { kind: 'bug', title: 7, description: 'a description' }],
    ['nothing at all', null],
  ])('refuses %s as invalid input', async (_label, body) => {
    const answer = await submit(FEEDBACK_URL, member.cookie, body);
    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');
  });

  it.each([
    ['title', MAX_FEEDBACK_TITLE_LENGTH],
    ['description', MAX_FEEDBACK_DESCRIPTION_LENGTH],
  ])('refuses a %s one character over the ceiling rather than truncating it', async (field, ceiling) => {
    const offset = mailOffset(mailPath);
    const marker = `over-${field}-${Date.now().toString(36)}`;
    const answer = await submit(FEEDBACK_URL, member.cookie, {
      kind: 'bug',
      title: field === 'title' ? `${marker}${'x'.repeat(ceiling)}` : marker,
      description: field === 'description' ? `${marker}${'x'.repeat(ceiling)}` : 'a description',
    });

    expect(answer.status).toBe(400);
    expect(answer.code).toBe('invalid_input');

    // Refused rather than shortened: nothing went out at all. Somebody who wrote four pages is owed
    // the refusal, not a silently cut report they will never know was cut.
    const captured = await waitForMail(mailPath, offset, (all) =>
      all.some((one) => one.subject.includes(marker)),
      2_000,
    );
    expect(captured.some((one) => one.subject.includes(marker))).toBe(false);
  });
});

describe('when the mail provider is down', () => {
  it('tells the member it could not be sent, rather than claiming it was', async () => {
    const answer = await submit<{ error?: { message?: string } }>(MAIL_DOWN_URL, member.cookie, {
      kind: 'bug',
      title: 'the provider is refusing',
      description: 'Nothing is stored behind this, so a silent failure would lose the report.',
    });

    // `service_unavailable` — retryable, and it says so, because there is no row to retry from and
    // the only copy of this report is still in the form the member typed it into.
    expect(answer.status).toBe(503);
    expect(answer.code).toBe('service_unavailable');
    expect(answer.body.error?.message).toMatch(/try again/i);
  });
});
