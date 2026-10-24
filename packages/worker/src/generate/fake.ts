import { readFileSync } from 'node:fs';
import {
  REVIEW_FIELD,
  TARGET_CHAPTER_MS,
  chaptersThatFit,
  type ProposedCitation,
  type ProposedMindMap,
} from '@thp/shared';
import { readGenerateFakeScriptPath, type EnvSource } from './env';
import {
  GenerationError,
  type ChapterRequest,
  type ChapterResult,
  type GeneratedDraft,
  type GeneratedDrafts,
  type GenerationRequest,
  type GenerationResult,
  type Generator,
  type ProposedChapter,
  type ReflectionRequest,
  type ReflectionResult,
} from './generator';
import { CHAPTER_PROMPT_VERSION, PROMPT_VERSION, REFLECTION_PROMPT_VERSION } from './prompt';

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
  /** The segmentations it was asked for, in order. Read for the same reason `requests` is. */
  readonly chapterRequests: readonly ChapterRequest[];
  /** The reflection requests, in order ([3.14.4](docs/project/prd.md)). */
  readonly reflectionRequests: readonly ReflectionRequest[];
}

/**
 * **What the fake writes for a subject** ([3.14.4](docs/project/prd.md)): a question that names
 * the subject's title, so a test can find the chapter's words in the question a member is shown
 * without a script that has to know the chapter titles in advance.
 */
export function fakeReflectionFor(title: string): string {
  return `Thinking about "${title}" — where has this shown up in your week, and where has it not yet?`;
}

/**
 * One script. Keys are field names, so a script reads like the answer it stands in for — a
 * paragraph for a text field, a list of proposed citations for a list-shaped one.
 */
export type FakeDraftScript = Readonly<
  Record<
    string,
    string | readonly ProposedCitation[] | readonly FakeChapterText[] | ProposedMindMap
  >
>;

/**
 * **What a script says about chapters** — the words, and never the boundaries.
 *
 * The fake decides *where* to cut on its own, from the length of the teaching it is handed and
 * {@link TARGET_CHAPTER_MS} — so a short teaching yields fewer than two proposals and
 * [3.22.4](docs/project/prd.md)'s "gets none" is reachable end to end without a script that has to
 * know how long the fixture is. What the script supplies is the *text*, so a suite can search for a
 * word it chose ([3.22.11](docs/project/prd.md)) rather than for a string this file invented.
 *
 * Under the key `chapters`. A script with none still produces chapters, titled by position — the
 * boundaries are the property most tests are about, and requiring text for them would make every
 * fixture carry words nobody asserts on.
 */
export interface FakeChapterText {
  readonly title: string;
  readonly summary: string;
}

export interface FakeGenerator extends Generator, FakeGeneratorCalls {}

export function fakeGenerator(script: FakeDraftScript): FakeGenerator {
  const requests: GenerationRequest[] = [];
  const chapterRequests: ChapterRequest[] = [];
  const reflectionRequests: ReflectionRequest[] = [];

  return {
    name: 'fake',
    requests,
    chapterRequests,
    reflectionRequests,

    /**
     * One question per subject, written from the subject's title — see {@link fakeReflectionFor}.
     * Every key asked for is answered, so the handler's "which came back missing" path is reached
     * only by a test that hands in a generator built to drop one.
     */
    async writeReflections(request: ReflectionRequest): Promise<ReflectionResult> {
      reflectionRequests.push(request);
      return {
        reflections: request.subjects.map((one) => ({
          key: one.key,
          question: fakeReflectionFor(one.title),
        })),
        promptVersion: REFLECTION_PROMPT_VERSION,
        spend: {
          model: 'fake',
          modelVersion: 'fake-1',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          requestId: `fake-reflections-${reflectionRequests.length}`,
        },
      };
    },

    /**
     * **Cut the teaching into even parts, at the target chapter length.**
     *
     * Derived from the request rather than read off the script, and that is what makes the fake
     * useful for the requirement rather than merely quiet: a teaching that fits fewer than two
     * chapters comes back with **none**, which is [3.22.4](docs/project/prd.md)'s case reached
     * without a fixture that had to be told how long it is. A real model cuts where the teaching
     * turns; a fake has no idea where that is, and pretending otherwise would be a second
     * implementation to reason about.
     *
     * Every boundary is placed on the **first line at or after** the arithmetic position, so what
     * this answers already satisfies [3.22.5](docs/project/prd.md) — which is not the handler being
     * trusted, it is the fake not producing garbage the handler would then have to correct in a way
     * no test could tell from correcting a real model's.
     */
    async segmentChapters(request: ChapterRequest): Promise<ChapterResult> {
      chapterRequests.push(request);

      const wanted = chaptersThatFit(request.durationMs);
      const text = script['chapters'];
      const words = Array.isArray(text) ? (text as readonly FakeChapterText[]) : [];

      const chapters: ProposedChapter[] = [];
      for (let index = 0; index < wanted; index += 1) {
        const at = index * TARGET_CHAPTER_MS;
        const line =
          request.lines.find((one) => one.startMs >= at) ?? request.lines[request.lines.length - 1];
        if (line === undefined) break;
        // A boundary a previous part already claimed is dropped rather than repeated: two chapters
        // may not start at the same moment, and a fixture with few lines can land twice on one.
        if (chapters.some((one) => one.startMs === line.startMs)) continue;
        const said = words[index];
        chapters.push({
          startMs: line.startMs,
          title: said?.title ?? `Part ${index + 1}`,
          summary: said?.summary ?? `The ${index + 1}th part of this teaching.`,
        });
      }

      return {
        chapters,
        promptVersion: CHAPTER_PROMPT_VERSION,
        spend: {
          model: 'fake',
          modelVersion: 'fake-1',
          inputTokens: 0,
          outputTokens: 0,
          // Nothing was spent, and the column says so rather than carrying a plausible number.
          costUsd: 0,
          requestId: `fake-chapters-${chapterRequests.length}`,
        },
      };
    },
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

        if (field.shape === 'tree') {
          // A tree the script says nothing about is **built from the transcript** rather than
          // refused: every chain run produces a map, and a fixture written before maps existed
          // should keep producing one. A script that does name one has to name a tree.
          if (value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
            throw new GenerationError(`the fake script's ${field.name} is not a tree of themes`);
          }
          drafts[kind] = (value as ProposedMindMap | undefined) ?? treeFromLines(request);
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
/**
 * A small, deterministic map read off the transcript: up to three themes, one per line from the
 * start, middle and end of the teaching, each carrying the line's offset and one point under it.
 * Enough for a screen to draw and a test to expand; nothing a fixture has to say.
 */
function treeFromLines(request: GenerationRequest): ProposedMindMap {
  const lines = request.lines;
  const picks = [0, Math.floor(lines.length / 2), lines.length - 1]
    .filter((index, at, all) => index >= 0 && all.indexOf(index) === at)
    .map((index) => lines[index])
    .filter((line): line is NonNullable<typeof line> => line !== undefined);

  return {
    themes: picks.map((line, index) => ({
      label: `Theme ${index + 1}`,
      anchorMs: line.startMs,
      points: [{ label: line.text.slice(0, 60), anchorMs: line.startMs }],
    })),
  };
}

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
