/**
 * What a message is, before anything knows how it will be sent.
 *
 * Both parts are required rather than optional. A transactional message with no plain-text
 * alternative is a message that reads as a blank page in a text client, in a notification preview,
 * and to a screen reader that has been handed a table-based HTML layout — and an invitation whose
 * link only exists inside the HTML is an invitation some people cannot accept.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Thrown by a transport that could not deliver. Always retryable — see the mailer. */
export class MailDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailDeliveryError';
  }
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}
