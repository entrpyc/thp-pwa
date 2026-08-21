import { readFileSync } from 'node:fs';
import { readFakeScriptPath, type EnvSource } from './env';
import {
  TranscriptionError,
  type Transcriber,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './transcriber';

/**
 * A transcriber that reads a fixed script off disk.
 *
 * **Configuration, not a mock.** `ASR_PROVIDER=fake` is a value of the same setting `deepgram` is,
 * exactly as `MAIL_TRANSPORT=capture` is — so "the suite never reaches a provider" is a property of
 * how the process was configured rather than of a stub somebody remembered to install in each file.
 * It is also what lets a developer run the whole pipeline end to end with no account and no spend.
 *
 * The script is a JSON file holding what a provider would have said: a language, a confidence, the
 * billed duration and the segments. Which recording it was asked about does not change the answer —
 * a fake that varied by input would be a second implementation to reason about.
 */

/** The last thing the fake was asked to transcribe. Read by tests asserting what reached it. */
export interface FakeTranscriberCalls {
  readonly requests: readonly TranscriptionRequest[];
}

/**
 * One segment of a script. `speaker` is **optional**, so a script written before diarisation
 * existed still parses and still produces the null speakers every segment already written has —
 * which is what lets the suite drive both answers without a provider.
 */
export interface FakeScriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: number | null;
}

export interface FakeScript {
  readonly language: string;
  readonly confidence: number;
  readonly durationSeconds: number;
  readonly segments: readonly FakeScriptSegment[];
}

export interface FakeTranscriber extends Transcriber, FakeTranscriberCalls {}

export function fakeTranscriber(script: FakeScript): FakeTranscriber {
  const requests: TranscriptionRequest[] = [];

  return {
    name: 'fake',
    requests,
    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      requests.push(request);
      return {
        language: script.language,
        confidence: script.confidence,
        segments: script.segments.map((one) => ({
          startMs: one.startMs,
          endMs: one.endMs,
          text: one.text,
          speaker: one.speaker ?? null,
        })),
        spend: {
          model: 'fake',
          modelVersion: 'fake-1',
          durationSeconds: script.durationSeconds,
          // Nothing was spent, and the column says so rather than carrying a plausible number that
          // an operator reading docs/project/prd.md §7's spend would have to know to discount.
          costUsd: 0,
          requestId: `fake-${requests.length}`,
        },
      };
    },
  };
}

/** Build the fake from the file `ASR_FAKE_SCRIPT` names. */
export function fakeTranscriberFromEnv(env: EnvSource = process.env): FakeTranscriber {
  const path = readFakeScriptPath(env);
  let script: FakeScript;
  try {
    script = JSON.parse(readFileSync(path, 'utf8')) as FakeScript;
  } catch (cause) {
    throw new TranscriptionError(`ASR_FAKE_SCRIPT points at ${path}, which could not be read`, {
      cause,
    });
  }
  return fakeTranscriber(script);
}
