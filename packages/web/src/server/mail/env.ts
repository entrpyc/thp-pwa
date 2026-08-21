import { normaliseOrigin } from '@/client/config';

/**
 * Mail configuration, read here and nowhere else — the same discipline `packages/db/src/env.ts`
 * applies to `DATABASE_URL`, and for the same reason: a missing setting should fail with one
 * sentence naming the variable, not as a socket error three frames deep.
 *
 * **No vendor is compiled in.** The adapter speaks SMTP, which every candidate speaks, so moving
 * between Resend, Postmark, a Fastmail mailbox and a self-hosted relay is four environment values
 * rather than a change of code. `.env.example` ships Resend's host because that is what this
 * deployment sends through; nothing in the source knows that.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which transport to build.
 *
 * - `smtp` — the real one. The only one a deployment should ever name.
 * - `capture` — appends each message to a JSON-lines file instead of sending it. What the
 *   integration suite reads, and what lets a developer open the actual rendered invitation in a
 *   browser rather than trusting that it looks right.
 * - `failing` — refuses every message. Exists so "a send failure leaves the invitation in place
 *   and is retryable" is a thing the suite can drive rather than a claim about intent.
 */
export const MAIL_TRANSPORTS = ['smtp', 'capture', 'failing'] as const;

export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

export function readTransportName(env: EnvSource = process.env): MailTransportName {
  const configured = (env['MAIL_TRANSPORT'] ?? 'smtp').trim().toLowerCase();
  if ((MAIL_TRANSPORTS as readonly string[]).includes(configured)) {
    return configured as MailTransportName;
  }
  throw new Error(
    `MAIL_TRANSPORT is "${configured}". It must be one of ${MAIL_TRANSPORTS.join(', ')} — see .env.example.`,
  );
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly password: string;
}

function require_(env: EnvSource, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is not set, and MAIL_TRANSPORT is "smtp". See .env.example.`);
  }
  return value.trim();
}

export function readSmtpSettings(env: EnvSource = process.env): SmtpSettings {
  const port = Number.parseInt(env['MAIL_PORT']?.trim() ?? '465', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`MAIL_PORT is "${env['MAIL_PORT']}", which is not a port number.`);
  }
  return {
    host: require_(env, 'MAIL_HOST'),
    port,
    // Implicit TLS on 465, STARTTLS on everything else. Both are encrypted; the flag only says
    // whether the connection begins that way.
    secure: port === 465,
    user: require_(env, 'MAIL_USER'),
    password: require_(env, 'MAIL_PASSWORD'),
  };
}

/** Who the invitation appears to come from. Required for every transport — capture included, so
 * that what a developer opens in a browser is the message a deployment would actually send. */
export function readMailFrom(env: EnvSource = process.env): string {
  const value = env['MAIL_FROM'];
  if (!value || value.trim() === '') {
    throw new Error('MAIL_FROM is not set. Nothing sends a message without a sender — see .env.example.');
  }
  return value.trim();
}

/** Where a captured message is written. Under `.tmp/`, which is gitignored. */
export function readCapturePath(env: EnvSource = process.env): string {
  const value = env['MAIL_CAPTURE_PATH'];
  if (!value || value.trim() === '') {
    throw new Error(
      'MAIL_CAPTURE_PATH is not set, and MAIL_TRANSPORT is "capture". Point it at a file under ' +
        '.tmp/ — see .env.example.',
    );
  }
  return value.trim();
}

/**
 * The origin an invitation link points at — the Next server, which serves both the accept screen
 * and the API. Read from `NEXT_PUBLIC_API_ORIGIN` rather than from a second variable, because in
 * this epic they are the same host and two variables would be two chances to set one wrong.
 *
 * Never derived from the incoming request's `Host` header: that header is attacker-controlled, and
 * a link built from it is a link an attacker chooses the destination of.
 */
export function readAppOrigin(env: EnvSource = process.env): string {
  const configured = env['NEXT_PUBLIC_API_ORIGIN'];
  if (!configured || configured.trim() === '') {
    throw new Error(
      'NEXT_PUBLIC_API_ORIGIN is not set, so an invitation link has no origin to point at.',
    );
  }
  return normaliseOrigin(configured);
}
