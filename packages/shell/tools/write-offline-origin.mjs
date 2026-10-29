// Points the offline screen's retry at the origin the shell is being synced against.
//
// `www/offline.html` is a local file that `server.errorPath` loads when the origin cannot be
// reached (capacitor.config.ts). Its retry is a plain navigation to the origin — on Android the
// file has no Capacitor plugins, so it cannot ask the bridge — and the origin is whatever
// `THP_SHELL_SERVER_URL` says at sync time, exactly as capacitor.config.ts reads it. This runs
// before `cap sync` (package.json) and rewrites the page's `data-origin` to match, so a build
// against a development server retries against that server. With the variable unset it writes the
// production origin, which is what the committed file holds.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_ORIGIN = 'https://thp.indepthwebsolutions.com';

const origin = (process.env.THP_SHELL_SERVER_URL ?? '').trim().replace(/\/+$/, '') || PRODUCTION_ORIGIN;
const page = resolve(dirname(fileURLToPath(import.meta.url)), '../www/offline.html');
const before = readFileSync(page, 'utf8');
const after = before.replace(/data-origin="[^"]*"/, `data-origin="${origin}"`);
if (!after.includes(`data-origin="${origin}"`)) throw new Error('offline.html has no data-origin attribute');
if (after !== before) {
  writeFileSync(page, after);
  console.log(`offline.html retries against ${origin}`);
}
