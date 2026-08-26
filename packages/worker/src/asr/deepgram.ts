import { readAsrApiKey, type EnvSource } from './env';
import {
  TranscriptionError,
  type TranscribedSegment,
  type Transcriber,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './transcriber';

/**
 * **The one file in the repository permitted to name the ASR provider** —
 * tests/guards/asr-boundary.test.ts fails the build if a second one appears, exactly as
 * `mail/transports.ts` is the one file permitted to import a mail library and
 * `@thp/media`'s `s3-store.ts` the one permitted to import the S3 SDK.
 *
 * It speaks Deepgram's pre-recorded API over plain `fetch`. No SDK: the call is one `POST` with a
 * JSON body naming a URL, and a dependency to make that shorter would be a dependency between the
 * application and a vendor's release cadence for no gain.
 *
 * **Synchronous, not a polled job.** The pre-recorded endpoint answers with the transcript, so the
 * worker is blocked in one HTTPS request for the few minutes a 90-minute file takes — which is what
 * `running` means in Ticket 04's view. Acceptable because concurrency is pinned to 1 and the volume
 * is ~4.3 recordings a month.
 */

/** Where the pre-recorded endpoint lives. The only URL this application ever calls a provider at. */
export const DEEPGRAM_ENDPOINT = 'https://api.deepgram.com/v1/listen';

/**
 * Nova-3, monolingual. The model the cost table is built on
 * (project tdd 8.2): the multilingual variant is ~21% more
 * and, with English pinned, buys nothing.
 */
export const DEEPGRAM_MODEL = 'nova-3';

/** $0.0043 a minute — $0.258 an hour, which is the published monolingual pre-recorded rate. */
export const DEEPGRAM_USD_PER_MINUTE = 0.0043;

/**
 * Thirty minutes. Well past the few a 90-minute file takes, and a ceiling rather than an
 * expectation: what it stops is a worker blocked forever on a provider that never answers, which
 * would sit `running` until somebody restarted the process.
 */
export const DEEPGRAM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * **The keyterm seam, deliberately left open and deliberately empty.**
 *
 * Nova-3 English accepts keyterms, and that is the mitigation
 * [§7](docs/project/prd.md)'s ministry-vocabulary risk gets — names, places and terminology the
 * model has never heard. It stays empty because a term list is something somebody curates through a
 * screen and there is no screen. Filling it is a scope decision, and this is where it attaches.
 */
export const DEEPGRAM_KEYTERMS: readonly string[] = [];

/** The `fetch` the adapter calls. A parameter so a unit test can drive a refusal without a network. */
export type HttpTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface DeepgramOptions {
  readonly apiKey?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  readonly env?: EnvSource;
}

export function deepgramTranscriber(options: DeepgramOptions = {}): Transcriber {
  const { env = process.env, timeoutMs = DEEPGRAM_TIMEOUT_MS } = options;
  const apiKey = options.apiKey ?? readAsrApiKey(env);
  const transport = options.transport ?? (globalThis.fetch as unknown as HttpTransport);

  return {
    name: 'deepgram',

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      const url = requestUrl(request);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let body: string;
      try {
        const response = await transport(url, {
          method: 'POST',
          headers: {
            authorization: `Token ${apiKey}`,
            'content-type': 'application/json',
          },
          // The provider fetches the object itself from the signed URL. The bytes never come here.
          body: JSON.stringify({ url: request.audioUrl }),
          signal: controller.signal,
        });

        if (!response.ok) {
          // The status, and the provider's own words, truncated — a refusal names the file it
          // refused and an operator reads this off the failed job row.
          const detail = (await response.text().catch(() => '')).slice(0, 400);
          throw new TranscriptionError(
            `Deepgram refused the audio with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          );
        }
        body = await response.text();
      } catch (cause) {
        clearTimeout(timer);
        if (cause instanceof TranscriptionError) throw cause;
        if (controller.signal.aborted) {
          throw new TranscriptionError(
            `Deepgram did not answer within ${Math.round(timeoutMs / 60_000)} minutes`,
            { cause },
          );
        }
        throw new TranscriptionError(
          `Deepgram could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      clearTimeout(timer);

      return mapDeepgramResponse(body, request.language);
    },
  };
}

/**
 * The query the call is made with.
 *
 * `smart_format` is what produces the punctuated sentences a segment is; without it the response
 * carries words and nothing to group them by. The language is the request's, sent explicitly —
 * which is the difference between "the transcript says `en`" and "the transcript was transcribed as
 * English".
 *
 * `diarize` is asked for **unconditionally** rather than behind a setting: a knob with one caller
 * is a knob nobody needs, and a transcript that records who was speaking is not something one
 * deployment would want and another would not. It does not change the pre-recorded rate, which is
 * what keeps project tdd 8.2 standing as written.
 */
function requestUrl(request: TranscriptionRequest): string {
  const query = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: request.language,
    smart_format: 'true',
    diarize: 'true',
  });
  for (const term of DEEPGRAM_KEYTERMS) query.append('keyterm', term);
  return `${DEEPGRAM_ENDPOINT}?${query.toString()}`;
}

/**
 * The provider's response, turned into the port's answer.
 *
 * **Everything vendor-shaped stops here.** Deepgram answers with channels, alternatives, words and
 * paragraphs; a segment is a *sentence*, and the words inside it are not persisted. Sentence
 * offsets come back in seconds as floats and are rounded to milliseconds, because a seek lands on
 * an integer or it lands on whatever the last rounding chose.
 *
 * **A sentence takes its paragraph's speaker.** Diarisation is attributed at paragraph level and a
 * segment is a sentence, so the paragraph is the only place the answer exists; a paragraph with no
 * speaker on it — which is every paragraph of a response that was not diarised — gives its
 * sentences `null` rather than failing the mapping.
 *
 * Exported so the mapping is unit-testable against a captured response without a transport in the
 * way — the shape of what comes back is the part most likely to change under us.
 */
export function mapDeepgramResponse(body: string, language: string): TranscriptionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new TranscriptionError('Deepgram answered with something that is not JSON', { cause });
  }

  const response = parsed as DeepgramResponse;
  const alternative = response?.results?.channels?.[0]?.alternatives?.[0];
  if (!alternative) {
    throw new TranscriptionError('Deepgram answered with no transcript in it');
  }

  const segments: TranscribedSegment[] = [];
  for (const paragraph of alternative.paragraphs?.paragraphs ?? []) {
    const speaker = typeof paragraph.speaker === 'number' ? paragraph.speaker : null;
    for (const sentence of paragraph.sentences ?? []) {
      const text = (sentence.text ?? '').trim();
      if (text === '') continue;
      segments.push({
        startMs: Math.round((sentence.start ?? 0) * 1000),
        endMs: Math.round((sentence.end ?? 0) * 1000),
        text,
        speaker,
      });
    }
  }

  const metadata = response.metadata;
  const modelId = metadata?.models?.[0] ?? '';
  const info = modelId === '' ? undefined : metadata?.model_info?.[modelId];
  const durationSeconds = metadata?.duration ?? 0;

  return {
    language,
    confidence: alternative.confidence ?? 0,
    segments,
    spend: {
      model: info?.name ?? DEEPGRAM_MODEL,
      modelVersion: info?.version ?? '',
      durationSeconds,
      costUsd: costOf(durationSeconds),
      requestId: metadata?.request_id ?? '',
    },
  };
}

/** What this job cost, to the cent-fraction the rate is quoted in. */
export function costOf(durationSeconds: number): number {
  return Number(((durationSeconds / 60) * DEEPGRAM_USD_PER_MINUTE).toFixed(6));
}

/** Only the parts of the response this adapter reads. The rest is the provider's business. */
interface DeepgramResponse {
  readonly metadata?: {
    readonly request_id?: string;
    readonly duration?: number;
    readonly models?: readonly string[];
    readonly model_info?: Record<string, { readonly name?: string; readonly version?: string }>;
  };
  readonly results?: {
    readonly channels?: readonly {
      readonly alternatives?: readonly {
        readonly confidence?: number;
        readonly paragraphs?: {
          readonly paragraphs?: readonly {
            /** The anonymous speaker index, present only when diarisation was asked for. */
            readonly speaker?: number;
            readonly sentences?: readonly {
              readonly text?: string;
              readonly start?: number;
              readonly end?: number;
            }[];
          }[];
        };
      }[];
    }[];
  };
}
