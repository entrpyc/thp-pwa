import { feedbackKindLabel, type FeedbackKind } from '@thp/shared';
import type { MailMessage } from './message';
import { MAIL_THEME } from './theme';

/**
 * **The report email** — the third message this product sends, and the first one aimed *inward*.
 *
 * The invitation and the reset both go to somebody who is about to press a link. This goes to
 * whoever maintains the thing, about something a member found wrong with it, and the difference
 * changes every decision in the template:
 *
 * - **The subject line is the report.** `Bug report: the player restarts on refresh` is readable in
 *   a notification, sorts sensibly in a mailbox, and is what a maintainer will paste into an issue
 *   tracker. The kind is the prefix rather than a tag at the end because a truncated subject should
 *   still say which of the two arrived.
 * - **The reporter is named, and named first.** Display name and address, above the description,
 *   because "who saw this" is the first question anybody reading it will have. There is no
 *   `Reply-To`: replying means writing to the address printed in the body, which is one copy and
 *   paste rather than a header this mail port does not carry.
 * - **Their role is not here**, and its absence is deliberate rather than an omission. Nothing
 *   outside the policy module touches `actor.role` — one place decides, and a template that reached
 *   for the field to print a word would be the first module to do it for a reason that is not an
 *   authorisation decision. The address identifies the reporter; what they were doing is what the
 *   description is for.
 * - **The description is reproduced verbatim, wrapped rather than reflowed.** A member pasting a
 *   URL, an error message or a sequence of steps has already chosen the line breaks, and an email
 *   that closes them up is an email that loses the steps.
 * - **Nothing is a link.** The other two templates exist to get somebody to press something; this
 *   one has nothing to press, so it has no button, and it inherits the rest of their rules for the
 *   same reasons — no images, no web fonts, no tracking pixel, and a plain-text part carrying the
 *   whole report, because a maintainer triaging on a phone is reading the preview.
 */

export interface FeedbackMessageInput {
  /** The maintainer's address. Never a member's — see `readFeedbackRecipient`. */
  readonly to: string;
  readonly kind: FeedbackKind;
  readonly title: string;
  readonly description: string;
  /** Who wrote it, so the first triage question — "who saw this" — is answered on sight. */
  readonly reporterName: string;
  readonly reporterEmail: string;
  /** When it was sent, so a message delayed in a queue does not read as one sent just now. */
  readonly submittedAt: Date;
  readonly productName?: string;
}

const DEFAULT_PRODUCT_NAME = 'Teaching Hub';

/** The same fixed rendering the reset message uses, so two messages in one inbox agree about time. */
function formatSubmittedAt(submittedAt: Date): string {
  const time = submittedAt.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const day = submittedAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${time} UTC on ${day}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function feedbackSubject(input: FeedbackMessageInput): string {
  return `${feedbackKindLabel(input.kind)}: ${input.title}`;
}

export function feedbackText(input: FeedbackMessageInput): string {
  const productName = input.productName ?? DEFAULT_PRODUCT_NAME;
  return [
    `${feedbackKindLabel(input.kind)} from ${productName}.`,
    '',
    `From: ${input.reporterName} <${input.reporterEmail}>`,
    `Sent: ${formatSubmittedAt(input.submittedAt)}`,
    '',
    `Title: ${input.title}`,
    '',
    'Description:',
    input.description,
    '',
    `Reply to ${input.reporterEmail} to reach whoever sent this.`,
  ].join('\n');
}

export function feedbackHtml(input: FeedbackMessageInput): string {
  const t = MAIL_THEME;
  const productName = escapeHtml(input.productName ?? DEFAULT_PRODUCT_NAME);
  const label = escapeHtml(feedbackKindLabel(input.kind));

  // The same swap the reset template makes, and for the same reason: every style here lives in a
  // double-quoted `style="…"` attribute, and the token's font stack spells "Inter" with double
  // quotes — which would close the attribute mid-value.
  const fontStack = t.fontSans.replace(/"/g, "'");
  const body = `font-family:${fontStack};font-size:16px;line-height:1.5;`;

  // `pre-wrap` rather than `<br>` substitution: the member's own line breaks survive, and so does
  // an indented sequence of steps, without this template deciding what a paragraph is.
  const description = `white-space:pre-wrap;word-break:break-word;`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${productName}</title>
</head>
<body style="margin:0;padding:0;background:${t.bg};${body}color:${t.text};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.bg};">
<tr><td align="center" style="padding:${t.space8} ${t.space4};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:${t.surface};border-radius:${t.radiusMd};">
<tr><td style="padding:${t.space8} ${t.space6};">

<p style="margin:0 0 ${t.space2};${body}color:${t.textDim};font-size:14px;text-transform:uppercase;letter-spacing:0.08em;">${label}</p>

<p style="margin:0 0 ${t.space6};${body}color:${t.text};font-size:20px;font-weight:600;">${escapeHtml(input.title)}</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 ${t.space6};background:${t.surfaceRaised};border-radius:${t.radiusSm};">
<tr><td style="padding:${t.space4} ${t.space5};">
<p style="margin:0 0 ${t.space1};${body}color:${t.textMuted};font-size:14px;">${escapeHtml(input.reporterName)} &lt;${escapeHtml(input.reporterEmail)}&gt;</p>
<p style="margin:0;${body}color:${t.textDim};font-size:14px;">${escapeHtml(formatSubmittedAt(input.submittedAt))}</p>
</td></tr>
</table>

<p style="margin:0 0 ${t.space6};${body}${description}color:${t.text};">${escapeHtml(input.description)}</p>

<p style="margin:0;${body}color:${t.textDim};font-size:14px;">Reply to ${escapeHtml(input.reporterEmail)} to reach whoever sent this.</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function feedbackMessage(input: FeedbackMessageInput): MailMessage {
  return {
    to: input.to,
    subject: feedbackSubject(input),
    html: feedbackHtml(input),
    text: feedbackText(input),
  };
}
