/**
 * The negative control for tools/asr-boundary.ts. A second door to the transcription provider,
 * both ways it can be opened: a module that is not the adapter reaching for a provider SDK, and one
 * calling the provider's API by URL with no dependency at all.
 */
import { createClient } from '@deepgram/sdk';

export const leaked = createClient('a-key');

export async function alsoLeaked(audioUrl: string) {
  return fetch('https://api.deepgram.com/v1/listen', {
    method: 'POST',
    body: JSON.stringify({ url: audioUrl }),
  });
}
