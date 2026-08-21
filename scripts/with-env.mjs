// Load the repository-root .env, then run the given entry point in this same process.
//
// Why not `node --env-file`: Next.js spawns workers that inherit execArgv, and it rejects that flag
// in NODE_OPTIONS. Loading the file here keeps one .env at the root for every command.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { config } from 'dotenv';

// A test that runs this entry point in order to observe how it behaves with a given environment
// has to be able to *supply* that environment. Without this opt-out the developer's own .env leaks
// into the child and the test measures their machine instead of the command — which is exactly what
// happened to the seed-admin suite once a real SEED_ADMIN_PASSWORD was set locally.
if (process.env.THP_SKIP_DOTENV !== '1') {
  config({ path: new URL('../.env', import.meta.url), quiet: true });
}

const [entry, ...rest] = process.argv.slice(2);
if (!entry) {
  process.stderr.write('usage: node scripts/with-env.mjs <entry> [args...]\n');
  process.exit(2);
}

const entryPath = resolve(entry);
process.argv = [process.argv[0], entryPath, ...rest];
await import(pathToFileURL(entryPath).href);
