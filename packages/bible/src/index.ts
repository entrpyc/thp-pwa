export {
  BIBLE_SOURCES,
  BIBLE_VARIABLES,
  readBibleBaseUrl,
  readBibleSource,
  readBibleTranslation,
  type BibleSourceName,
  type EnvSource,
} from './env';
export { NO_TEXT, type BibleSource, type Passage, type Verse } from './source';
export { fakeBibleSource } from './fake';
export { bibleSource, buildBibleSource } from './configured';
export {
  resolvePassages,
  type PassageResolution,
  type ResolveOptions,
  type ResolvedPassage,
} from './passages';
