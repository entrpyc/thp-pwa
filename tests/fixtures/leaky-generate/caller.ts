/**
 * The negative control for tools/generate-boundary.ts. A second door to the generation provider,
 * both ways it can be opened: a module that is not the adapter reaching for a model SDK, and one
 * calling a provider's API by URL with no dependency at all.
 */
import Anthropic from '@anthropic-ai/sdk';

export const leaked = new Anthropic({ apiKey: 'a-key' });

export async function alsoLeaked(prompt: string) {
  return fetch('https://api.minimax.io/anthropic/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
}

/** A vendor nobody chose, reached by URL. The list is candidates, not only the one in use. */
export async function leakedElsewhere(prompt: string) {
  return fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ input: prompt }),
  });
}
