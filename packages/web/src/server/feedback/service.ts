import {
  MAX_FEEDBACK_DESCRIPTION_LENGTH,
  MAX_FEEDBACK_TITLE_LENGTH,
  isFeedbackKind,
  type FeedbackKind,
  type FeedbackSubmittedPayload,
} from '@thp/shared';
import { ApiError } from '@/server/api/errors';
import type { Actor } from '@/server/auth/policy';
import { readFeedbackRecipient } from '@/server/mail/env';
import { feedbackMessage } from '@/server/mail/feedback-message';
import { sendMail } from '@/server/mail/mailer';
import { logger } from '@/server/observability/logger';

/**
 * **A member reports something, and it arrives in a maintainer's inbox.**
 *
 * The shortest service in the product, and the shape of it is the point: validate, compose, send.
 * There is no row, no id and no second read, because nothing here is a resource — a report is an
 * *event*, the message is its only representation, and the member is told it was sent rather than
 * shown a thing that now exists.
 *
 * That single decision is what every difference from the neighbouring services comes down to:
 *
 * - **A send failure is a refusal the member sees.** Every other sender in this codebase writes a
 *   row first and then swallows or logs what the transport says, because the intent survives the
 *   failure and can be retried from what was stored. Nothing is stored here, so a failure that was
 *   reported as success would lose the report silently and the member would never know. It comes
 *   back as `service_unavailable`, and the form keeps the text so trying again costs a press.
 * - **Nothing about the report is written to the log.** The title and the description are a
 *   member's own words, and a log line is the wrong place for them — the recipient, the kind and
 *   who sent it are enough to answer "did that report actually go out", which is the only question
 *   the log is here to settle. It is the same rule the mailer already applies to a message body.
 *
 * **The reporter is the session, never the body.** There is no `from` field on the wire and there
 * will not be one: a report that could name somebody else is a way to send mail as them. What
 * travels is the display name and the address — **not the role**, because nothing outside the
 * policy module touches `actor.role`, and printing one in an email is not an authorisation
 * decision.
 */

/** What the member reads when the message could not be handed to the provider. */
const SEND_FAILED_MESSAGE =
  'Your report could not be sent just now. Your text is still here — try again in a moment.';

export async function submitFeedback(
  actor: Actor,
  body: unknown,
): Promise<FeedbackSubmittedPayload> {
  const fields = asObject(body, 'Send a JSON object with the kind, the title and the description.');

  const kind = readKind(fields['kind']);
  const title = readText(
    fields['title'],
    'title',
    MAX_FEEDBACK_TITLE_LENGTH,
    'Give the report a title so it can be told apart in an inbox.',
  );
  const description = readText(
    fields['description'],
    'description',
    MAX_FEEDBACK_DESCRIPTION_LENGTH,
    'Describe what happened — a report with no description cannot be acted on.',
  );

  const to = readFeedbackRecipient();

  await sendMail(
    feedbackMessage({
      to,
      kind,
      title,
      description,
      reporterName: actor.displayName,
      reporterEmail: actor.email,
      submittedAt: new Date(),
    }),
    SEND_FAILED_MESSAGE,
  );

  logger.info('feedback.submitted', {
    actorId: actor.id,
    actorEmail: actor.email,
    action: 'feedback.submit',
    target: `feedback:${kind}`,
    // Which of the two arrived and where it went, and nothing more. Not a length, not a hash, not
    // the first line — the member's own words are in the message and nowhere else.
    kind,
    recipient: to,
  });

  return { submitted: true };
}

function asObject(body: unknown, complaint: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw ApiError.invalidInput(complaint);
  return body as Record<string, unknown>;
}

function readKind(value: unknown): FeedbackKind {
  if (!isFeedbackKind(value)) {
    throw ApiError.invalidInput('A report is either a bug or feedback. Say which.');
  }
  return value;
}

/**
 * One field, or the refusal.
 *
 * **Trimmed, then measured**, on the same terms a note's text is: padding cannot push a real report
 * over the ceiling, and a field holding nothing but spaces is a field holding nothing. Over-long
 * text is refused rather than truncated — somebody who wrote four pages is owed the refusal, not a
 * silently shortened report they will never know was cut.
 */
function readText(value: unknown, field: string, ceiling: number, whenEmpty: string): string {
  if (typeof value !== 'string') {
    throw ApiError.invalidInput(`The ${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') throw ApiError.invalidInput(whenEmpty);
  if (trimmed.length > ceiling) {
    throw ApiError.invalidInput(
      `The ${field} is longer than ${ceiling.toLocaleString('en-GB')} characters. Shorten it and send again.`,
    );
  }
  return trimmed;
}
