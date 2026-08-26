/**
 * Verse-source configuration, read here and nowhere else — the same discipline `asr/env.ts` applies
 * to the transcription block, `generate/env.ts` to generation and `packages/media/src/env.ts` to the
 * bucket. A missing setting should fail with one sentence naming the variable, not as a 404 three
 * frames deep inside a source call.
 *
 * **No source is compiled in**, and **the translation has no default.** A default *source* is a
 * thing, and it is the real one, exactly as `ASR_PROVIDER` defaults to `deepgram`. A default
 * translation is not: which translation a deployment publishes is a licensing decision and an
 * editorial one (scope prd 3.3.7), and quietly picking one on a deployment's
 * behalf is how a teaching ends up carrying words nobody chose.
 */

import { isExternalMocked } from '@thp/shared/mock';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Which verse source to build.
 *
 * - `free-use` — the real one. The only one a deployment should ever name.
 * - `fake` — answers every citation from a local template and reaches no network. What the whole
 *   suite runs against, and what lets a developer drive the pipeline end to end with no account.
 *   The same shape as `ASR_PROVIDER=fake` and `MAIL_TRANSPORT=capture`.
 */
export const BIBLE_SOURCES = ['free-use', 'fake'] as const;

export type BibleSourceName = (typeof BIBLE_SOURCES)[number];

/**
 * `THP_MOCK_EXTERNAL` is read first and **wins over an explicitly named real source** — see
 * `@thp/shared/mock` for why the switch can have no exceptions and still mean anything
 * (scope prd 3.3.10).
 */
export function readBibleSource(env: EnvSource = process.env): BibleSourceName {
  if (isExternalMocked(env)) return 'fake';
  const configured = (env['BIBLE_SOURCE'] ?? 'free-use').trim().toLowerCase();
  if ((BIBLE_SOURCES as readonly string[]).includes(configured)) {
    return configured as BibleSourceName;
  }
  throw new Error(
    `BIBLE_SOURCE is "${configured}". It must be one of ${BIBLE_SOURCES.join(', ')} — see .env.example.`,
  );
}

/** Every variable this module reads, named in one place so a reader can find the block. */
export const BIBLE_VARIABLES = ['BIBLE_SOURCE', 'BIBLE_BASE_URL', 'BIBLE_TRANSLATION'] as const;

function require_(env: EnvSource, name: string, because: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is not set, and ${because} See .env.example.`);
  }
  return value.trim();
}

/**
 * **The one translation this deployment publishes** (scope prd 3.3.7).
 *
 * Required whichever source is in use, and never defaulted: it is the first part of the verse
 * cache's key, so a run that has not been told which translation it is holding cannot store a verse
 * at all — with the fake as much as with the real source.
 */
export function readBibleTranslation(env: EnvSource = process.env): string {
  return require_(
    env,
    'BIBLE_TRANSLATION',
    'a verse is held under the translation it came from, so there is nothing to default to.',
  );
}

/** Where the real source lives. Only read when `BIBLE_SOURCE=free-use`. */
export function readBibleBaseUrl(env: EnvSource = process.env): string {
  return require_(env, 'BIBLE_BASE_URL', 'BIBLE_SOURCE is "free-use".').replace(/\/+$/, '');
}
