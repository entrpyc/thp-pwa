/**
 * The suite's audio processor.
 *
 * The worker's `process_audio` step runs **in the test process** for the pipeline suites, and its
 * processor is chosen by `PROCESS_AUDIO_PROVIDER`, which defaults to ffmpeg. A developer's `.env`
 * hides that: `THP_MOCK_EXTERNAL=true` there forces the fake, and the harness inherits it. A machine
 * with no `.env` — CI — inherits nothing, shells out to ffmpeg over the 256 bytes of filler the
 * suite uploads, and every chain stops at its first step.
 *
 * So the fake is named here, the way tests/setup/bible.ts names the verse source: the suite's
 * configuration is the suite's. The fake copies the original to the rendition key unchanged and
 * needs no binary, which is the whole of what the pipeline's shape depends on. Transcription and
 * drafting are not named here because the suites hand those handlers their fakes directly.
 */
export const TEST_AUDIO_PROCESSOR = {
  PROCESS_AUDIO_PROVIDER: 'fake',
} as const;
