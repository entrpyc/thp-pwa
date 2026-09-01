import { MAX_CHAPTER_MS, MIN_CHAPTER_MS, REVIEW_FIELD, type ReviewKind } from '@thp/shared';
import type { ChapterRequest, GenerationRequest, TranscriptLine } from './generator';

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
  scripture:
    'Every passage of the Bible the teaching is built on — one entry per passage, with the book ' +
    'spelled in full, the chapter, and the first and last verse of the range. A passage taught ' +
    'from a whole chapter may leave the verses out. Include only what the transcript actually ' +
    'quotes or works through; do not add passages that merely say something similar, and answer ' +
    'with an empty list if the teaching works from no passage at all. Where the transcript shows ' +
    'clearly where a passage is read out or worked through, give the offset of that line as ' +
    'anchorMs; leave anchorMs out where the passage is only mentioned in passing or where you ' +
    'cannot place it, and never guess at one.',
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
    .map((kind) => `- ${REVIEW_FIELD[kind].name}: ${DRAFT_FIELD_INSTRUCTIONS[kind]}`)
    .join('\n');

  const steering =
    request.steeringPrompt === null
      ? ''
      : `\n\nThe admin reviewing the previous draft asked for this specifically, and it takes ` +
        `precedence over the general instructions above:\n${request.steeringPrompt}`;

  return (
    `Teaching title: ${request.title}\n\n` +
    `${OFFSET_NOTE}\n\n` +
    `Write the following:\n${wanted}${steering}\n\n` +
    `Transcript:\n${renderTranscript(request.lines)}`
  );
}

/**
 * What one citation looks like in the tool call.
 *
 * **Structured, never prose** (scope prd 3.1.2): the book, the chapter and the
 * range come back as four values the model filled in, rather than as a phrase somebody downstream
 * would have to parse. The book is asked for as words because that is what a model has; turning
 * those words into a book of the canon — or dropping the citation — happens after the answer, in
 * one place, where it is counted.
 */
const CITATION_SCHEMA = {
  type: 'object',
  properties: {
    book: { type: 'string', description: 'The book of the Bible, spelled in full.' },
    chapter: { type: 'integer', description: 'The chapter number.' },
    verseStart: { type: 'integer', description: 'The first verse of the range. Omit for a whole chapter.' },
    verseEnd: { type: 'integer', description: 'The last verse of the range, or the first for a single verse.' },
    /**
     * [3.7.10](docs/project/prd.md)'s anchor. **Not required**, and that is the requirement rather
     * than leniency: a passage the transcript gave no position for carries none and belongs to the
     * recording rather than to any chapter.
     */
    anchorMs: {
      type: 'integer',
      description:
        'The offset of the transcript line where this passage is read out or worked through, ' +
        'copied exactly from the brackets at the start of that line. Omit it where the passage ' +
        'cannot be placed.',
    },
  },
  required: ['book', 'chapter'],
} as const;

/**
 * The tool's parameter schema, carrying **only the fields this request asked for**.
 *
 * Filtered rather than fixed, so a single-kind regeneration does not pay for a description it is
 * going to throw away — and so "the handler generates only the kinds the payload names" is true at
 * the request rather than only at the write.
 *
 * A field's shape decides whether it is asked for as a paragraph or as a list, which is what makes
 * a fourth artefact a value in `REVIEW_FIELD` rather than a branch here.
 */
export function buildToolSchema(kinds: readonly ReviewKind[]): {
  readonly type: 'object';
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: string[];
} {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const kind of kinds) {
    const field = REVIEW_FIELD[kind];
    properties[field.name] =
      field.shape === 'list'
        ? { type: 'array', description: DRAFT_FIELD_INSTRUCTIONS[kind], items: CITATION_SCHEMA }
        : { type: 'string', description: DRAFT_FIELD_INSTRUCTIONS[kind] };
  }
  return { type: 'object', properties, required: kinds.map((kind) => REVIEW_FIELD[kind].name) };
}

// =================================================================================================
// The transcript, as a model is shown it — and the two things that fall out of showing offsets.
// =================================================================================================

/**
 * **The transcript as one block of text, with the offset of each line on it.**
 *
 * `[123456] Good morning, and welcome.` — milliseconds in brackets, because milliseconds are what
 * comes back and a timecode the model had to convert is a second chance to get a number wrong.
 *
 * One function, called by both prompts, so the scripture anchor of
 * [3.7.10](docs/project/prd.md) and the chapter boundary of [3.22.5](docs/project/prd.md) are
 * offsets into *the same* rendering. If the two prompts numbered their lines differently, an anchor
 * and a boundary would be measuring the same teaching with two rulers.
 */
export function renderTranscript(lines: readonly TranscriptLine[]): string {
  return lines.map((line) => `[${line.startMs}] ${line.text}`).join('\n');
}

/**
 * What the model is told about the numbers in front of every line.
 *
 * Stated once and prepended to both prompts, so neither can describe them differently.
 */
export const OFFSET_NOTE =
  'Each line of the transcript begins with the number of milliseconds from the start of the ' +
  'recording at which that line is spoken, in square brackets. The brackets and the number are ' +
  'not part of what was said.';

// =================================================================================================
// Chapters ([3.22.1](docs/project/prd.md)) — its own prompt, its own version, its own tool.
// =================================================================================================

/**
 * The prompt version stamped on every chapter list this prompt produces
 * ([4.19](docs/project/prd.md), *Generated by*).
 *
 * **Its own label**, separate from {@link PROMPT_VERSION}: chapters are produced by a different
 * call with a different instruction, and sharing a version would make "which prompt produced this"
 * unanswerable the first time either changes without the other.
 */
export const CHAPTER_PROMPT_VERSION = 'chapters-1';

/** The tool the model is forced to call for a chapter list. */
export const CHAPTER_TOOL_NAME = 'record_chapters';

/** The instruction the model is given about what a chapter is. */
export const CHAPTER_SYSTEM_PROMPT =
  'You are dividing a recorded Bible teaching into chapters for the ministry that gave it. A ' +
  'chapter is a stretch of the teaching that holds one theme, named so that somebody who heard the ' +
  'teaching once can find the part they came back for. You are given the full transcript of one ' +
  'teaching, produced by automatic speech recognition, so it may contain mis-heard names and ' +
  'terms. Write only from what the transcript says: do not invent themes, scripture references or ' +
  'claims that are not in it. Plain text with line breaks only — no markdown, no headings, no ' +
  'bullet lists. ' +
  `Answer by calling the ${CHAPTER_TOOL_NAME} tool and in no other way.`;

/**
 * The whole of what is sent with the transcript, for a segmentation.
 *
 * Three things it states and one it does not. It states the **length range**
 * ([3.22.4](docs/project/prd.md)) in minutes rather than milliseconds, because that is the unit the
 * requirement is written in and the unit a model reasons about a teaching in; it states that the
 * first chapter begins at the beginning ([3.22.2](docs/project/prd.md)); and it states that a
 * boundary must be the offset of a line rather than a moment between two
 * ([3.22.5](docs/project/prd.md)).
 *
 * What it does **not** state is what to do when the teaching is too short — because it does not
 * need to: a model asked for chapters of fifteen to twenty-five minutes on a twelve-minute teaching
 * has nowhere to put two, and the handler drops a list of one regardless
 * ([3.22.4](docs/project/prd.md)). Telling the model a rule the handler already enforces would put
 * the requirement in two places, one of which is a sentence a model may ignore.
 */
export function buildChapterUserPrompt(request: ChapterRequest): string {
  const minutes = (ms: number) => Math.round(ms / 60_000);

  return (
    `Teaching title: ${request.title}\n\n` +
    `${OFFSET_NOTE}\n\n` +
    `Divide this teaching into chapters, cutting where the teaching turns to something new. ` +
    `Aim for chapters of ${minutes(MIN_CHAPTER_MS)} to ${minutes(MAX_CHAPTER_MS)} minutes; the ` +
    `recording runs ${minutes(request.durationMs)} minutes in total. The first chapter begins at ` +
    `the first line of the transcript, and each chapter runs until the next one begins, so there ` +
    `are no gaps between them and no overlaps. The start of a chapter must be the offset of one of ` +
    `the lines below, copied exactly.\n\n` +
    `Give each chapter a title of a few words naming what it covers, and a summary of one short ` +
    `paragraph saying what is taught in it.\n\n` +
    `Transcript:\n${renderTranscript(request.lines)}`
  );
}

/**
 * The chapter tool's parameter schema.
 *
 * One property — a list of objects — rather than three parallel lists, because a chapter is one
 * thing with three fields and three lists that have to line up is three chances for a model to
 * produce a boundary with somebody else's title on it.
 */
export const CHAPTER_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      description:
        'The chapters of this teaching, in the order they occur. An empty list if the teaching is ' +
        'too short to divide.',
      items: {
        type: 'object',
        properties: {
          startMs: {
            type: 'integer',
            description:
              'The offset this chapter begins at, copied exactly from the brackets at the start ' +
              'of one of the transcript lines.',
          },
          title: {
            type: 'string',
            description: 'A few words naming what this chapter covers.',
          },
          summary: {
            type: 'string',
            description: 'One short paragraph saying what is taught in this chapter.',
          },
        },
        required: ['startMs', 'title', 'summary'],
      },
    },
  },
  required: ['chapters'],
} as const;
