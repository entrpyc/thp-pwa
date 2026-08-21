import type { MailMessage } from './message';
import { MAIL_THEME } from './theme';

/**
 * The password-reset email — the **second** message this product sends, and the first proof that
 * ticket 3 built a mail *port* rather than an invitation mailer with a general-sounding name. It goes
 * through the same `Mailer`, over the same transport, with the same single sender address, and adds
 * no library and no configuration.
 *
 * It inherits the invitation template's three decisions, for the same reasons: no images, no web
 * fonts and no tracking pixel; one thing to press, repeated as plain text for clients that rewrite
 * or refuse the button; and a plain-text part carrying the same link, because that is what a text
 * client, a notification preview and some accessibility tooling actually read.
 *
 * What it adds is what a reset message specifically owes its reader:
 *
 * - **It says how long the link lasts**, in words, so an hour-old message is self-explaining.
 * - **It says what to do if it was not you** — nothing has changed yet, and ignoring it is safe.
 *   That sentence is the difference between an alarming message and an informative one.
 *
 * **It names no role and nothing else about the account.** Not the display name, not whether the
 * address is an admin one, not when the account was created. A message that lands in an inbox
 * should not tell a stranger reading over a shoulder which addresses are worth attacking, and the
 * one fact it does confirm — that a reset was requested — is the fact its recipient just asked for.
 */

export interface PasswordResetMessageInput {
  readonly to: string;
  readonly resetUrl: string;
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

export function passwordResetSubject(productName = DEFAULT_PRODUCT_NAME): string {
  return `Reset your ${productName} password`;
}

export function passwordResetText(input: PasswordResetMessageInput): string {
  const productName = input.productName ?? DEFAULT_PRODUCT_NAME;
  return [
    `Somebody asked to reset the password for this ${productName} account.`,
    '',
    'Open this link and choose a new one:',
    '',
    input.resetUrl,
    '',
    `The link stops working at ${formatExpiry(input.expiresAt)} — reset links last one hour. If it runs out, ask for another from the sign-in screen.`,
    '',
    'If this was not you, ignore this message. Nothing has changed, and nothing will until somebody opens that link.',
  ].join('\n');
}

export function passwordResetHtml(input: PasswordResetMessageInput): string {
  const t = MAIL_THEME;
  const productName = escapeHtml(input.productName ?? DEFAULT_PRODUCT_NAME);
  const url = escapeHtml(input.resetUrl);

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

<p style="margin:0 0 ${t.space6};${body}color:${t.text};font-size:20px;font-weight:600;">Reset your password</p>

<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};">Somebody asked to reset the password for this ${productName} account. Choose a new one and you are straight back in.</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${t.space6};">
<tr><td align="center" bgcolor="${t.primary}" style="background:${t.primary};border-radius:${t.radiusSm};">
<a href="${url}" style="display:inline-block;padding:14px ${t.space6};${body}color:${t.text};font-weight:600;text-decoration:none;">Choose a new password</a>
</td></tr>
</table>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">Or paste this into your browser:</p>
<p style="margin:0 0 ${t.space6};${body}color:${t.textMuted};font-size:14px;word-break:break-all;">${url}</p>

<p style="margin:0 0 ${t.space4};${body}color:${t.textDim};font-size:14px;">The link stops working at ${escapeHtml(formatExpiry(input.expiresAt))} &mdash; reset links last one hour. If it runs out, ask for another from the sign-in screen.</p>
<p style="margin:0;${body}color:${t.textDim};font-size:14px;">If this was not you, ignore this message. Nothing has changed, and nothing will until somebody opens that link.</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function passwordResetMessage(input: PasswordResetMessageInput): MailMessage {
  return {
    to: input.to,
    subject: passwordResetSubject(input.productName),
    html: passwordResetHtml(input),
    text: passwordResetText(input),
  };
}
