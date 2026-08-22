import { REVIEW_FIELD, type ReviewKind } from '@thp/shared';
import type { GenerationRequest } from './generator';

/**
 * **What the model is asked for, and the label that says which version asked.**
 *
 * Its own module beside the adapter rather than inside it, for two reasons. The prompt is the part
 * most likely to change under a read of the first real drafts, and it is the part that has nothing
 * to do with which vendor is behind the port — the boundary guard refuses a provider name in here,
 * and it should.
 *
 * **This file names no provider.** It describes two artefacts and the shape they come back in.
 */

/**
 * The prompt version stamped on every draft this prompt produces
 * ([4.17.5](docs/project/prd.md)).
 *
 * **Hand-maintained, and bumped by hand when the text below changes.** Deriving it — hashing the
 * strings, say — would make it a value that changes when a comma moves and stays the same when the
 * meaning of the instruction changes with the model behind it. The value is meaningless as anything
 * but a label an operator compares two drafts with, and deriving it would make it lie.
 */
export const PROMPT_VERSION = 'draft-1';

/** The tool the model is forced to call. The name is arbitrary and is part of the contract. */
export const DRAFT_TOOL_NAME = 'record_draft';

/**
 * What each artefact is, in the words the model is given.
 *
 * `Record<ReviewKind, …>` rather than a lookup with a fallback: a kind added to `REVIEW_KINDS`
 * stops the build until somebody says what the model should write for it, which is the one question
 * about a new artefact that genuinely cannot be guessed.
 */
export const DRAFT_FIELD_INSTRUCTIONS: Record<ReviewKind, string> = {
  summary:
    'A summary of the teaching in three to six paragraphs of plain prose. Say what was taught, ' +
    'in the order it was taught, in the speaker’s own terms. Do not evaluate it, do not ' +
    'address the reader, and do not open with a phrase like "In this teaching".',
  recording_metadata:
    'A description of one or two sentences, of the kind that sits under a title in a list. It ' +
    'should say what the teaching is about clearly enough that somebody scanning a list can tell ' +
    'it apart from the one above it.',
};

/** The instruction the model is given about who it is writing for and what it is reading. */
export const SYSTEM_PROMPT =
  'You are drafting notes about a recorded Bible teaching for the ministry that gave it. You are ' +
  'given the full transcript of one teaching, produced by automatic speech recognition, so it may ' +
  'contain mis-heard names and terms. Write only from what the transcript says. Do not invent ' +
  'scripture references, names, dates or claims that are not in it, and do not add commentary of ' +
  'your own. Plain text with line breaks only — no markdown, no headings, no bullet lists. ' +
  `Answer by calling the ${DRAFT_TOOL_NAME} tool and in no other way.`;

/**
 * The whole of what is sent with the transcript.
 *
 * The steering sentence goes **last and is labelled as the admin's**, so a regeneration reads as
 * "here is the standing instruction, and here is what the person reviewing it asked you to change"
 * rather than as two instructions of equal weight that may contradict each other.
 */
export function buildUserPrompt(request: GenerationRequest): string {
  const wanted = request.kinds
    .map((kind) => `- ${REVIEW_FIELD[kind]}: ${DRAFT_FIELD_INSTRUCTIONS[kind]}`)
    .join('\n');

  const steering =
    request.steeringPrompt === null
      ? ''
      : `\n\nThe admin reviewing the previous draft asked for this specifically, and it takes ` +
        `precedence over the general instructions above:\n${request.steeringPrompt}`;

  return (
    `Teaching title: ${request.title}\n\n` +
    `Write the following:\n${wanted}${steering}\n\n` +
    `Transcript:\n${request.transcript}`
  );
}

/**
 * The tool's parameter schema, carrying **only the fields this request asked for**.
 *
 * Filtered rather than fixed, so a single-kind regeneration does not pay for a description it is
 * going to throw away — and so "the handler generates only the kinds the payload names" is true at
 * the request rather than only at the write.
 */
export function buildToolSchema(kinds: readonly ReviewKind[]): {
  readonly type: 'object';
  readonly properties: Record<string, { type: 'string'; description: string }>;
  readonly required: string[];
} {
  const properties: Record<string, { type: 'string'; description: string }> = {};
  for (const kind of kinds) {
    properties[REVIEW_FIELD[kind]] = {
      type: 'string',
      description: DRAFT_FIELD_INSTRUCTIONS[kind],
    };
  }
  return { type: 'object', properties, required: kinds.map((kind) => REVIEW_FIELD[kind]) };
}
