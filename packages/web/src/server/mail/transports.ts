import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTransport } from 'nodemailer';
import { MailDeliveryError, type MailMessage, type MailTransport } from './message';
import {
  readCapturePath,
  readMailFrom,
  readSmtpSettings,
  readTransportName,
  type EnvSource,
  type MailTransportName,
} from './env';

/**
 * The three transports, and the only file in the repository that imports a mail library.
 *
 * `tests/guards/mail-boundary.test.ts` fails the build if anything else does — the same shape of
 * rule as "the API reaches Postgres through one module", and for the same reason: a second door to
 * the outside world is a second place a message can be sent from without the logging, the failure
 * handling or the single sender address that this one applies.
 */

/** The real one. SMTP, because every candidate vendor speaks it and none of them are named here. */
export function smtpTransport(env: EnvSource = process.env): MailTransport {
  const settings = readSmtpSettings(env);
  const from = readMailFrom(env);
  const transporter = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.password },
  });

  return {
    name: 'smtp',
    async send(message: MailMessage): Promise<void> {
      try {
        await transporter.sendMail({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (cause) {
        // The cause is attached for the server-side log and never reaches the caller — an SMTP
        // rejection can quote the recipient and the credentials it was offered.
        throw new MailDeliveryError('SMTP delivery failed.', { cause });
      }
    },
  };
}

export interface CapturedMail extends MailMessage {
  readonly from: string;
  readonly capturedAt: string;
}

/**
 * Development and test. Appends the whole message — headers, HTML and text — as one JSON line, so
 * a test can assert against it and a developer can pull the HTML out and open it in a browser.
 *
 * A file rather than a Mailpit container: the thing being observed is *what we composed*, and a
 * file answers that completely. Watching a real client render it is a manual check, made against a
 * real client, which no local SMTP sink would improve.
 */
export function captureTransport(env: EnvSource = process.env): MailTransport {
  const path = readCapturePath(env);
  const from = readMailFrom(env);

  return {
    name: 'capture',
    async send(message: MailMessage): Promise<void> {
      const line: CapturedMail = { ...message, from, capturedAt: new Date().toISOString() };
      try {
        mkdirSync(dirname(path), { recursive: true });
        // Synchronous and append-only: two requests capturing at once must not interleave halves
        // of two JSON lines, and a reader must never see a partial one.
        appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
      } catch (cause) {
        throw new MailDeliveryError(`Could not write the captured message to ${path}.`, { cause });
      }
    },
  };
}

/** Refuses everything. The negative control for "a send failure does not destroy the invitation". */
export function failingTransport(): MailTransport {
  return {
    name: 'failing',
    send(): Promise<void> {
      return Promise.reject(
        new MailDeliveryError('MAIL_TRANSPORT is "failing"; no message is ever sent.'),
      );
    },
  };
}

export function buildTransport(
  name: MailTransportName = readTransportName(),
  env: EnvSource = process.env,
): MailTransport {
  switch (name) {
    case 'smtp':
      return smtpTransport(env);
    case 'capture':
      return captureTransport(env);
    case 'failing':
      return failingTransport();
  }
}
