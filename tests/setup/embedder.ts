/**
 * The suite's embedder.
 *
 * The worker's `embed` step runs **in the test process** for every pipeline suite — it is the last
 * link of the chain, and a transcript correction, a chapter edit, a note or an approved summary
 * each enqueue it — and its adapter is chosen by `EMBED_PROVIDER`, which defaults to the real one.
 * A developer's `.env` hides that: `THP_MOCK_EXTERNAL=true` there forces the fake, and the harness
 * inherits it. A machine with no `.env` — CI — inherits nothing, asks for a key nobody set, and
 * every chain ends on a red row for a reason that has nothing to do with the test.
 *
 * So the fake is named here, the way tests/setup/audio-processor.ts names the processor: the
 * suite's configuration is the suite's. The fake derives a vector from the words and needs no
 * key, which is the whole of what the pipeline's shape depends on. Suites that assert on what the
 * embedder was asked hand it in directly, as they hand in the transcriber and the generator.
 */
export const TEST_EMBEDDER = {
  EMBED_PROVIDER: 'fake',
} as const;
