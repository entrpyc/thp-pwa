import {
  AudioProcessingError,
  type AudioProcessor,
  type AudioProcessRequest,
  type ProcessedRendition,
} from './processor';

/**
 * The fake processor: **a copy, not a transcode.**
 *
 * The suite's machines have no ffmpeg and must not need one, but the step's shape still has to be
 * exercised for real — a second object appears in the store, the recording repoints at it, the
 * grant prefers it. Copying the original does all of that honestly; the only thing it does not do
 * is change the bytes, which is exactly the part the fake exists to skip. Its output *is* the
 * source's format, so the key it is stored under never names a format the object is not.
 */
export function fakeProcessor(): AudioProcessor {
  return {
    name: 'fake-copy',

    outputFor(sourceExtension: string, sourceContentType: string): ProcessedRendition {
      return { extension: sourceExtension, contentType: sourceContentType };
    },

    async process(request: AudioProcessRequest): Promise<void> {
      const source = await fetch(request.sourceUrl);
      if (!source.ok) {
        throw new AudioProcessingError(`the original could not be fetched (HTTP ${source.status})`);
      }
      const bytes = Buffer.from(await source.arrayBuffer());
      const stored = await fetch(request.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': request.contentType },
        body: bytes,
      });
      if (!stored.ok) {
        throw new AudioProcessingError(`the copy could not be stored (HTTP ${stored.status})`);
      }
    },
  };
}
