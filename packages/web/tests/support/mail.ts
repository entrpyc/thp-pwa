import { readFileSync, statSync } from 'node:fs';
import { INVITATION_TOKEN_PARAM } from '@thp/shared';

/**
 * Reading what the primary server sent.
 *
 * The suite runs that server with `MAIL_TRANSPORT=capture`, which appends every outgoing message
 * to a JSON-lines file instead of delivering it. Assertions read that file — so "one message, to
 * that address, carrying a link that works" is checked against the message we actually composed
 * rather than against a mock of the code that composes it.
 */

export interface CapturedMail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly capturedAt: string;
}

/** Byte offset to read the next slice of the outbox from, mirroring the log reader. */
export function mailOffset(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isCapturedMail(value: unknown): value is CapturedMail {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CapturedMail).to === 'string' &&
    typeof (value as CapturedMail).html === 'string' &&
    typeof (value as CapturedMail).text === 'string'
  );
}

export function readCapturedMail(path: string, offset = 0): CapturedMail[] {
  let raw: string;
  try {
    raw = readFileSync(path).subarray(offset).toString('utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter(isCapturedMail);
}

/** Poll until `predicate` is satisfied — the send happens inside a request we have already left. */
export async function waitForMail(
  path: string,
  offset: number,
  predicate: (messages: CapturedMail[]) => boolean,
  timeoutMs = 15_000,
): Promise<CapturedMail[]> {
  const deadline = Date.now() + timeoutMs;
  let messages: CapturedMail[] = [];
  while (Date.now() < deadline) {
    messages = readCapturedMail(path, offset);
    if (predicate(messages)) return messages;
    await new Promise((done) => setTimeout(done, 100));
  }
  return messages;
}

/**
 * The token out of a message, taken from the **plain-text** part.
 *
 * Deliberately the text part: it is what a text client, a notification preview and some
 * accessibility tooling read, so extracting from it proves the link is genuinely there rather than
 * only inside the HTML table layout.
 */
export function tokenFromMail(message: CapturedMail): string {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  if (link === undefined) throw new Error('the plain-text part carries no link');
  const token = new URL(link).searchParams.get(INVITATION_TOKEN_PARAM);
  if (token === null || token === '') throw new Error(`no token in ${link}`);
  return token;
}

/** The accept link out of the HTML part, for comparing the two halves against each other. */
export function linkFromHtml(message: CapturedMail): string {
  const href = /href="([^"]+)"/.exec(message.html)?.[1];
  if (href === undefined) throw new Error('the HTML part carries no link');
  return href;
}
