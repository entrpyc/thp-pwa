import { ApiError } from '@/server/api/errors';
import { logger } from '@/server/observability/logger';
import { MailDeliveryError, type MailMessage, type MailTransport } from './message';
import { buildTransport } from './transports';

/**
 * **Every outbound message goes through here.** One place that decides what is logged about a
 * send, what a failure becomes on the wire, and which transport is in use.
 *
 * The transport is built once, lazily, and cached — building it per message would open an SMTP
 * connection pool per message.
 */

let transport: MailTransport | undefined;

/** Swap the transport. Tests use this; nothing in the application does. Returns a restore fn. */
export function setMailTransport(next: MailTransport): () => void {
  const previous = transport;
  transport = next;
  return () => {
    transport = previous;
  };
}

export function mailTransport(): MailTransport {
  transport ??= buildTransport();
  return transport;
}

/** What a delivery failure says when the caller has nothing more specific to offer. */
const GENERIC_FAILURE_MESSAGE = 'The message could not be sent. Try again in a moment.';

/**
 * Send, or refuse in a way the caller can act on.
 *
 * A delivery failure becomes `service_unavailable` — **retryable, and it says so**, because the row
 * behind the message is written before this is called and is still there afterwards. Losing the
 * record of an intent somebody already expressed would be the worse failure, and resend exists
 * precisely for that case (see the invitation service).
 *
 * `failureMessage` is the caller's chance to say what to do next, because only the caller knows
 * what exists on the other side of the failure. Step 4's password reset does not pass one: it
 * catches this refusal and answers with its own fixed payload instead, because a reset that told
 * the difference between "sent" and "could not send" would tell an anonymous caller whether the
 * address has an account.
 *
 * The recipient is logged; the body is not. Both bodies contain a working token.
 */
export async function sendMail(
  message: MailMessage,
  failureMessage: string = GENERIC_FAILURE_MESSAGE,
): Promise<void> {
  const active = mailTransport();
  try {
    await active.send(message);
    logger.info('mail.sent', {
      transport: active.name,
      to: message.to,
      subject: message.subject,
    });
  } catch (cause) {
    logger.error('mail.failed', {
      transport: active.name,
      to: message.to,
      subject: message.subject,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
      // A transport wraps the provider's own error as `cause`; it can quote credentials, so it is
      // written to the server log and nowhere else.
      errorCause:
        cause instanceof MailDeliveryError && cause.cause instanceof Error
          ? cause.cause.message
          : undefined,
    });
    throw ApiError.serviceUnavailable(failureMessage);
  }
}
