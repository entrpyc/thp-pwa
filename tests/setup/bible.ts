/**
 * The suite's verse source and translation.
 *
 * **The suite's, not the developer's** — the same argument tests/setup/media-bucket.ts makes about
 * the bucket. `.env` names a real Bible source, and scope prd 3.3.10 says a test
 * run reaches none: leaving it to be inherited would make "no test reaches a source" true only for
 * developers who happened to set `THP_MOCK_EXTERNAL`. The translation is named too, because it is
 * the first part of every cached verse's key and a suite whose key came from `.env` would hold
 * different rows on different machines — or, on a machine with no `.env` at all, hold none, because
 * a translation has no default and a run that has not been told which one it is holding cannot
 * store a verse.
 *
 * It lives in its own file because **two runtimes need it**: the Next servers the harness starts,
 * which are given it as environment, and the test processes themselves, where the worker's
 * `generate_draft` handler resolves passages in-process. vitest.config.ts hands it to the second
 * and cannot import tests/setup/global.ts to get it — that module reaches for the database.
 */
export const TEST_BIBLE = {
  BIBLE_SOURCE: 'fake',
  BIBLE_TRANSLATION: 'test-translation',
} as const;
