import type { MailMessage } from './message';
import { MAIL_THEME } from './theme';

/**
 * The invitation email — the first thing this product ever sends to a person.
 *
 * Three decisions worth stating, because each one is a thing the template deliberately does not do:
 *
 * 1. **No images, no web fonts, no tracking pixel.** Every client shows it identically with images
 *    off, and there is nothing to block. The one visual element is a filled button, which is a
 *    table cell with a background colour, so it survives clients that discard `<style>`.
 * 2. **One thing to press.** The accept link appears as the button and once more as plain text
 *    underneath, because some clients rewrite or refuse to render the button and a person should
 *    still be able to copy the address. Nothing else in the message is a link.
 * 3. **The plain-text part carries the same link.** It is not a courtesy copy — it is what a text
 *    client, a notification preview and some accessibility tooling actually read.
 *
 * The role is deliberately absent from both parts. What an invitee needs to know is who invited
 * them and what they are joining; whether the account is an admin one is operator detail, and
 * naming it in an email that lands in an inbox tells a stranger which addresses are worth attacking.
 */

export interface InvitationMessageInput {
  readonly to: string;
  /** The person who issued it, by display name. Absent when the row's inviter has been removed. */
  readonly invitedByName: string | null;
  readonly acceptUrl: string;
  /** For "expires on …", written out rather than as a countdown a stale inbox would misreport. */
  readonly expiresAt: Date;
  readonly productName?: string;
}

const DEFAULT_PRODUCT_NAME = 'Teaching Hub';

function formatExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function opening(invitedByName: string | null, productName: string): string {
  return invitedByName === null
    ? `You have been invited to ${productName}.`
    : `${invitedByName} has invited you to ${productName}.`;
}

export function invitationSubject(productName = DEFAULT_PRODUCT_NAME): string {
  return `You're invited to ${productName}`;
}

export function invitationText(input: InvitationMessageInput): string {
  const productName = input.productName ?? DEFAULT_PRODUCT_NAME;
  return [
    opening(input.invitedByName, productName),
    '',
    `${productName} is a private library of recorded teachings. Choose a password and you are in — there is nothing else to fill in.`,
    '',
    input.acceptUrl,
    '',
    `This invitation expires on ${formatExpiry(input.expiresAt)}. If it runs out, ask an admin to send a new one.`,
    '',
    `If you were not expecting this, ignore it — nothing happens until you choose a password.`,
  ].join('\n');
}

export function invitationHtml(input: InvitationMessageInput): string {
  const t = MAIL_THEME;
  // Escaped once, at the edge. `opening` composes already-escaped pieces, so nothing is escaped
  // twice and an ampersand in a display name stays an ampersand.
  const productName = escapeHtml(input.productName ?? DEFAULT_PRODUCT_NAME);
  const url = escapeHtml(input.acceptUrl);
  const lead = opening(
    input.invitedByName === null ? null : escapeHtml(input.invitedByName),
    productName,
  );

  // Every style here lives in a double-quoted `style="…"` attribute, and the token's font stack
  // spells "Inter" with double quotes — which would close the attribute mid-value. CSS accepts
  // single quotes for a family name, so they are swapped on the way in rather than the token being
  // written differently from the one the screens read.
  const fontStack = t.fontSans.replace(/"/g, "'");
  const body = `font-family:${fontStack};font-size:16px;line-height:1.5;`;

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

<p style="margin:0 0 ${t.space6};${body}color:${t.text};font-size:20px;font-weight:600;">${lead}</p>

<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};">${productName} is a private library of recorded teachings. Choose a password and you are in &mdash; there is nothing else to fill in.</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${t.space6};">
<tr><td align="center" bgcolor="${t.primary}" style="background:${t.primary};border-radius:${t.radiusSm};">
<a href="${url}" style="display:inline-block;padding:14px ${t.space6};${body}color:${t.text};font-weight:600;text-decoration:none;">Choose your password</a>
</td></tr>
</table>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">Or paste this into your browser:</p>
<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};font-size:14px;word-break:break-all;">${url}</p>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">This invitation expires on ${escapeHtml(formatExpiry(input.expiresAt))}. If it runs out, ask an admin to send a new one.</p>
<p style="margin:0;${body}color:${t.textDim};font-size:14px;">If you were not expecting this, ignore it &mdash; nothing happens until you choose a password.</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function invitationMessage(input: InvitationMessageInput): MailMessage {
  return {
    to: input.to,
    subject: invitationSubject(input.productName),
    html: invitationHtml(input),
    text: invitationText(input),
  };
}
