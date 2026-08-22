/**
 * `npm run check:origin` — **the built client calls the origin it was built for, and no other.**
 *
 * `NEXT_PUBLIC_API_ORIGIN` is inlined by Next at build time, so "the client calls the right origin"
 * is a property of the *artefact*, not of the environment the process later runs in. That makes it
 * unassertable from a running server and cheap to assert from the build output — which is why this
 * runs in CI immediately after `npm run build`, and again on the box inside `scripts/deploy.sh`.
 *
 * The failure it exists to catch is silent and expensive: a build made before `.env` held the
 * production origin produces a site that looks perfectly correct on the box and calls `localhost`
 * from every visitor's browser. Nothing else in the pipeline notices.
 *
 * tools/origin-boundary.ts is the other half of this rule and covers the source; this covers what
 * the source compiled into.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { walkFiles } from '../tools/fs-walk';

const CLIENT_BUNDLE_DIR = resolve(import.meta.dirname, '..', 'packages', 'web', '.next', 'static');

const configured = process.env['NEXT_PUBLIC_API_ORIGIN']?.trim().replace(/\/+$/, '');
if (!configured) {
  process.stderr.write('NEXT_PUBLIC_API_ORIGIN is not set, so there is no origin to check for.\n');
  process.exit(2);
}

const bundles = walkFiles(CLIENT_BUNDLE_DIR, ['.js']);
if (bundles.length === 0) {
  process.stderr.write(`No client bundle under ${CLIENT_BUNDLE_DIR}. Run \`npm run build\` first.\n`);
  process.exit(2);
}

/**
 * A local build legitimately *is* localhost, and then the two rules below contradict each other.
 * The presence rule still means something; the absence rule cannot, and says so rather than failing.
 */
const localBuild = /^https?:\/\/localhost\b/.test(configured);

const carrying: string[] = [];
const problems: string[] = [];
for (const bundle of bundles) {
  const source = readFileSync(bundle, 'utf8');
  if (source.includes(configured)) carrying.push(bundle);
  if (!localBuild && source.includes('http://localhost')) problems.push(`${bundle} carries http://localhost.`);
}
if (carrying.length === 0) {
  problems.unshift(`No client bundle carries ${configured}. The build did not see it.`);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `${bundles.length} client bundles checked: ${carrying.length} carry ${configured}` +
    `${localBuild ? '; localhost scan skipped, this is a local build' : ', none carry localhost'}.\n`,
);
