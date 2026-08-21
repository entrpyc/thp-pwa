import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Pull the most recent captured message out of the outbox and write its HTML to a file you can
 * open in a browser.
 *
 * `MAIL_TRANSPORT=capture` appends every outgoing message to `MAIL_CAPTURE_PATH` as JSON lines
 * rather than sending it. That file is what the test suite asserts against; this is the same file
 * read the other way, so a manual check of how a message *looks* is made against the message the
 * application actually composed rather than a re-render of it.
 *
 *   node tools/open-last-mail.mjs [.tmp/mail/outbox.jsonl]
 */
const source = resolve(process.argv[2] ?? '.tmp/mail/outbox.jsonl');
const lines = readFileSync(source, 'utf8').trim().split('\n').filter((line) => line.startsWith('{'));
const last = lines.at(-1);
if (last === undefined) throw new Error(`${source} holds no captured message.`);

const message = JSON.parse(last);
const out = resolve('.tmp/mail/last.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, message.html, 'utf8');

console.log(`to:      ${message.to}`);
console.log(`subject: ${message.subject}`);
console.log('');
console.log('--- plain-text part ---');
console.log(message.text);
console.log('');
console.log(`HTML written to ${out} — open it in a browser.`);
