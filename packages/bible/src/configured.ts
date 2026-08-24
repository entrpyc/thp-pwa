import { freeUseBibleSource } from './free-use';
import { fakeBibleSource } from './fake';
import { readBibleSource, type BibleSourceName, type EnvSource } from './env';
import type { BibleSource } from './source';

/**
 * Which source this process is configured with.
 *
 * A factory rather than a constant, for the reason `buildTranscriber` is one: building it at import
 * time would read the environment at import time, and a process with no Bible configuration at all
 * should fail when it first asks for a verse, naming the variable — not when it starts.
 */
export function buildBibleSource(env: EnvSource = process.env): BibleSource {
  const source: BibleSourceName = readBibleSource(env);
  switch (source) {
    case 'free-use':
      return freeUseBibleSource({ env });
    case 'fake':
      return fakeBibleSource();
  }
}

let cached: BibleSource | undefined;

/** The one this process uses, built once and cached — as the transcriber and the mailer are. */
export function bibleSource(): BibleSource {
  cached ??= buildBibleSource();
  return cached;
}
