import type { MailMessage } from './message';
import { MAIL_THEME } from './theme';

/**
 * The account-deletion email — the link a person who asked from the public page opens to finish
 * deleting their account ([3.1.8](docs/project/prd.md)).
 *
 * The password-reset message's shape, and its three inherited decisions: no images, no web fonts
 * and no tracking pixel; one thing to press, repeated as plain text; a plain-text part carrying
 * the same link. What a deletion message specifically owes its reader is sharper than a reset's:
 *
 * - **It says what will happen**, in one sentence, before the button — the account and everything
 *   private to it go, the public notes stay under a placeholder name — because the press that
 *   follows cannot be undone and the message is the last place to say so before the page does.
 * - **It says the link alone does nothing.** The page asks for the current password, so a
 *   forwarded message is not a deleted account. That is the sentence that makes the message safe
 *   to receive unasked.
 * - **It says how long the link lasts**, in words, and that ignoring it is safe.
 *
 * **It names nothing about the account** — not the display name, not the role, not when it was
 * made. The one fact it confirms, that somebody asked, is the fact its recipient just asked for.
 */

export interface AccountDeletionMessageInput {
  readonly to: string;
  readonly deletionUrl: string;
  /** For "the link stops working at …", written out rather than as a countdown a stale inbox lies about. */
  readonly expiresAt: Date;
  readonly productName?: string;
}

const DEFAULT_PRODUCT_NAME = 'Teaching Hub';

function formatExpiry(expiresAt: Date): string {
  const time = expiresAt.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const day = expiresAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
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

export function accountDeletionSubject(productName = DEFAULT_PRODUCT_NAME): string {
  return `Delete your ${productName} account`;
}

export function accountDeletionText(input: AccountDeletionMessageInput): string {
  const productName = input.productName ?? DEFAULT_PRODUCT_NAME;
  return [
    `Somebody asked to delete the ${productName} account for this address.`,
    '',
    'Deleting it removes the account, its private notes, its listening history and its picture for good. Public notes stay on their recordings under the name "Removed member".',
    '',
    'To go ahead, open this link and confirm with your current password:',
    '',
    input.deletionUrl,
    '',
    `The link stops working at ${formatExpiry(input.expiresAt)} — deletion links last one hour. If it runs out, ask for another from the same page.`,
    '',
    'If this was not you, ignore this message. The link alone does nothing: nobody can delete the account without its password.',
  ].join('\n');
}

export function accountDeletionHtml(input: AccountDeletionMessageInput): string {
  const t = MAIL_THEME;
  const productName = escapeHtml(input.productName ?? DEFAULT_PRODUCT_NAME);
  const url = escapeHtml(input.deletionUrl);

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

<p style="margin:0 0 ${t.space6};${body}color:${t.text};font-size:20px;font-weight:600;">Delete your account</p>

<p style="margin:0 0 ${t.space4};${body}color:${t.textMuted};">Somebody asked to delete the ${productName} account for this address.</p>
<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};">Deleting it removes the account, its private notes, its listening history and its picture for good. Public notes stay on their recordings under the name &ldquo;Removed member&rdquo;.</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${t.space6};">
<tr><td align="center" bgcolor="${t.primary}" style="background:${t.primary};border-radius:${t.radiusSm};">
<a href="${url}" style="display:inline-block;padding:14px ${t.space6};${body}color:${t.text};font-weight:600;text-decoration:none;">Continue to delete my account</a>
</td></tr>
</table>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">Or paste this into your browser:</p>
<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};font-size:14px;word-break:break-all;">${url}</p>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">The link stops working at ${escapeHtml(formatExpiry(input.expiresAt))} &mdash; deletion links last one hour. If it runs out, ask for another from the same page.</p>
<p style="margin:0;${body}color:${t.textDim};font-size:14px;">If this was not you, ignore this message. The link alone does nothing: nobody can delete the account without its password.</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function accountDeletionMessage(input: AccountDeletionMessageInput): MailMessage {
  return {
    to: input.to,
    subject: accountDeletionSubject(input.productName),
    html: accountDeletionHtml(input),
    text: accountDeletionText(input),
  };
}
