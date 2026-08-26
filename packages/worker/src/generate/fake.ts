import { readFileSync } from 'node:fs';
import { REVIEW_FIELD, type ProposedCitation } from '@thp/shared';
import { readGenerateFakeScriptPath, type EnvSource } from './env';
import {
  GenerationError,
  type GeneratedDraft,
  type GeneratedDrafts,
  type GenerationRequest,
  type GenerationResult,
  type Generator,
} from './generator';
import { PROMPT_VERSION } from './prompt';

/**
 * A generator that reads a fixed script off disk.
 *
 * **Configuration, not a mock.** `GENERATE_PROVIDER=fake` is a value of the same setting `minimax`
 * is, exactly as `ASR_PROVIDER=fake` and `MAIL_TRANSPORT=capture` are — so "the suite never reaches
 * a provider" is a property of how the process was configured rather than of a stub somebody
 * remembered to install in each file. It is also what lets a developer run the whole pipeline end
 * to end with no account and no spend.
 *
 * The script is a JSON file holding what a provider would have written, keyed by **field name** —
 * `summary` and `description`, the same keys the tool call carries. Which recording it was asked
 * about does not change the answer; a fake that varied by input would be a second implementation
 * to reason about. What it *does* honour is which kinds were asked for, because that is the
 * property a single-kind regeneration turns on.
 */

/** The last thing the fake was asked to draft. Read by tests asserting what reached it. */
export interface FakeGeneratorCalls {
  readonly requests: readonly GenerationRequest[];
}

/**
 * One script. Keys are field names, so a script reads like the answer it stands in for — a
 * paragraph for a text field, a list of proposed citations for a list-shaped one.
 */
export type FakeDraftScript = Readonly<Record<string, string | readonly ProposedCitation[]>>;

export interface FakeGenerator extends Generator, FakeGeneratorCalls {}

export function fakeGenerator(script: FakeDraftScript): FakeGenerator {
  const requests: GenerationRequest[] = [];

  return {
    name: 'fake',
    requests,
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      requests.push(request);

      const drafts: Record<string, GeneratedDraft> = {};
      for (const kind of request.kinds) {
        const field = REVIEW_FIELD[kind];
        const value = script[field.name];

        if (field.shape === 'list') {
          // A list-shaped field the script says nothing about answers **empty** rather than
          // failing: a teaching the machine finds no scripture in is a real result the pipeline has
          // to produce (scope prd 3.1.6), and a fake that could not produce it
          // would make that case untestable end to end.
          if (value !== undefined && !Array.isArray(value)) {
            throw new GenerationError(`the fake script's ${field.name} is not a list of entries`);
          }
          drafts[kind] = (value ?? []) as readonly ProposedCitation[];
          continue;
        }

        if (typeof value !== 'string' || value.trim() === '') {
          throw new GenerationError(
            `the fake script has no ${field.name} in it, and one was asked for`,
          );
        }
        // The steering sentence is echoed into the text, so a test can prove the second draft is
        // genuinely a second draft rather than the first one read back.
        drafts[kind] =
          request.steeringPrompt === null
            ? value
            : `${value}\n\n(Asked for again: ${request.steeringPrompt})`;
      }

      return {
        drafts: drafts as GeneratedDrafts,
        promptVersion: PROMPT_VERSION,
        spend: {
          model: 'fake',
          modelVersion: 'fake-1',
          inputTokens: 0,
          outputTokens: 0,
          // Nothing was spent, and the column says so rather than carrying a plausible number an
          // operator reading docs/project/prd.md §7's spend would have to know to discount.
          costUsd: 0,
          requestId: `fake-${requests.length}`,
        },
      };
    },
  };
}

/** Build the fake from the file `GENERATE_FAKE_SCRIPT` names. */
export function fakeGeneratorFromEnv(env: EnvSource = process.env): FakeGenerator {
  const path = readGenerateFakeScriptPath(env);
  let script: FakeDraftScript;
  try {
    script = JSON.parse(readFileSync(path, 'utf8')) as FakeDraftScript;
  } catch (cause) {
    throw new GenerationError(`GENERATE_FAKE_SCRIPT points at ${path}, which could not be read`, {
      cause,
    });
  }
  return fakeGenerator(script);
}
