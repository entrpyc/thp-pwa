import { REVIEW_FIELD, type ProposedCitation, type ReviewKind } from '@thp/shared';
import { readGenerateApiKey, type EnvSource } from './env';
import {
  GenerationError,
  type ChapterRequest,
  type ChapterResult,
  type GeneratedDraft,
  type GeneratedDrafts,
  type GenerationRequest,
  type GenerationResult,
  type GenerationSpend,
  type Generator,
  type ProposedChapter,
} from './generator';
import {
  CHAPTER_PROMPT_VERSION,
  CHAPTER_SYSTEM_PROMPT,
  CHAPTER_TOOL_NAME,
  CHAPTER_TOOL_SCHEMA,
  DRAFT_TOOL_NAME,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildChapterUserPrompt,
  buildToolSchema,
  buildUserPrompt,
} from './prompt';

/**
 * **The one file in the repository permitted to name the generation provider** —
 * tests/guards/generate-boundary.test.ts fails the build if a second one appears, exactly as
 * `asr/deepgram.ts` is the one file permitted to name a transcription provider and
 * `mail/transports.ts` the one permitted to import a mail library.
 *
 * It speaks MiniMax's **Anthropic-compatible** endpoint over plain `fetch`. No SDK: the call is one
 * `POST` with a JSON body, and a dependency to make that shorter would be a dependency between the
 * application and a vendor's release cadence for no gain — the same argument the Deepgram adapter
 * makes.
 *
 * **Two things worth knowing before the code.**
 *
 * 1. **The architecture says Claude and this is MiniMax.**
 *    core-listening scope tdd § Key choices names Claude behind a `generate`
 *    adapter; the operator chose MiniMax M3 instead. That same row calls the reversal cost
 *    *deliberately low* — a narrow port, one file — so the seam is working as designed rather than
 *    breaking. Recording it as a third entry under § Divergence from the north star is a Phase 4
 *    edit and deliberately not made here.
 * 2. **Structured output is a forced tool call, not a schema parameter.** Neither compatible
 *    surface documents JSON-schema response formatting; both document tool calling. So the two
 *    artefacts come back as one tool call carrying a two-property object, and a model that answers
 *    in prose instead **fails the job** with a reason — the same failure shape a bad ASR response
 *    already has, readable on `/admin/pipeline` and re-runnable from it.
 */

/** Where the Anthropic-compatible endpoint lives. The only URL this application generates at. */
export const MINIMAX_ENDPOINT = 'https://api.minimax.io/anthropic/v1/messages';

/** The version header the Anthropic-compatible surface expects. Not a model version. */
export const MINIMAX_API_VERSION = '2023-06-01';

/** The model the cost note is built on. */
export const MINIMAX_MODEL = 'MiniMax-M3';

/** $0.30 per million input tokens below the 512K-input tier. */
export const MINIMAX_USD_PER_MILLION_INPUT = 0.3;

/** $1.20 per million output tokens below the 512K-input tier. */
export const MINIMAX_USD_PER_MILLION_OUTPUT = 1.2;

/**
 * Enough room for the summary and the description of a 90-minute teaching, and no more. A ceiling
 * rather than a target: what it stops is a model that decides to retell the teaching.
 */
export const MINIMAX_MAX_OUTPUT_TOKENS = 4096;

/**
 * Enough room for the chapters of a ninety-minute teaching — five titles and five short paragraphs
 * — and no more. Its own ceiling rather than the draft's, because a ceiling sized for a
 * six-paragraph summary says nothing about a list of boundaries.
 */
export const MINIMAX_MAX_CHAPTER_TOKENS = 2048;

/**
 * Ten minutes. Well past the seconds a single completion takes, and a ceiling rather than an
 * expectation: what it stops is a worker blocked forever on a provider that never answers, which
 * would sit `running` until somebody restarted the process.
 */
export const MINIMAX_TIMEOUT_MS = 10 * 60 * 1000;

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

export interface MiniMaxOptions {
  readonly apiKey?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  readonly env?: EnvSource;
}

export function miniMaxGenerator(options: MiniMaxOptions = {}): Generator {
  const { env = process.env, timeoutMs = MINIMAX_TIMEOUT_MS } = options;
  const apiKey = options.apiKey ?? readGenerateApiKey(env);
  const transport = options.transport ?? (globalThis.fetch as unknown as HttpTransport);

  /**
   * **The one call**, shared by both methods of the port.
   *
   * Drafting and chapter segmentation are two instructions over one transcript against one
   * endpoint, and everything between the request body and the response text — the headers, the
   * timeout, the abort, the three ways a refusal is phrased — is identical for both. Written twice
   * it would be two places for a timeout to drift, so it is written once and the two methods differ
   * only in what they send and in how they read the answer back.
   */
  async function call(body: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await transport(MINIMAX_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': MINIMAX_API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The status, and the provider's own words, truncated — an operator reads this off the
        // failed job row and it has to say which end refused.
        const detail = (await response.text().catch(() => '')).slice(0, 400);
        throw new GenerationError(
          `The generation provider refused the request with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        );
      }
      return await response.text();
    } catch (cause) {
      if (cause instanceof GenerationError) throw cause;
      if (controller.signal.aborted) {
        throw new GenerationError(
          `The generation provider did not answer within ${Math.round(timeoutMs / 60_000)} minutes`,
          { cause },
        );
      }
      throw new GenerationError(
        `The generation provider could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'minimax',

    async generate(request: GenerationRequest): Promise<GenerationResult> {
      return mapResponse(await call(buildRequestBody(request)), request.kinds);
    },

    async segmentChapters(request: ChapterRequest): Promise<ChapterResult> {
      return mapChapterResponse(await call(buildChapterRequestBody(request)));
    },
  };
}

/**
 * The body of the one call.
 *
 * **The whole transcript goes in one message**, which is the one-call decision made concrete: the
 * transcript is the expensive half of the request and sending it twice would double the input cost
 * for two answers that ought to agree with each other.
 *
 * `tool_choice` names the tool rather than saying `auto`, which is what makes the structured answer
 * a requirement rather than a hope. Adaptive thinking is left off: summarising a transcript is not
 * reasoning-bound, and turning it on is one line here if a read of the first real drafts says
 * otherwise.
 *
 * Exported so a unit test can assert that one request carries the whole transcript without a
 * transport in the way.
 */
export function buildRequestBody(request: GenerationRequest): Record<string, unknown> {
  return {
    model: MINIMAX_MODEL,
    max_tokens: MINIMAX_MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(request) }],
    tools: [
      {
        name: DRAFT_TOOL_NAME,
        description: 'Record the drafted text for this teaching.',
        input_schema: buildToolSchema(request.kinds),
      },
    ],
    tool_choice: { type: 'tool', name: DRAFT_TOOL_NAME },
  };
}

/**
 * The provider's response, turned into the port's answer.
 *
 * **Everything vendor-shaped stops here.** The response is a list of content blocks; what the port
 * hands on is one string per kind and five numbers.
 *
 * **A prose answer fails.** A model that ignored `tool_choice` and wrote a paragraph produces no
 * tool-use block, and the honest thing to do with that is fail the job naming what happened rather
 * than trying to salvage a summary out of free text and writing it as though it were structured.
 * The operator re-runs the step, which is the same escape hatch every other provider failure has.
 *
 * Exported so the mapping is unit-testable against captured responses — the shape of what comes
 * back is the part most likely to change under us.
 */
export function mapResponse(body: string, kinds: readonly ReviewKind[]): GenerationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new GenerationError('The generation provider answered with something that is not JSON', {
      cause,
    });
  }

  const response = parsed as MiniMaxResponse;
  const call = (response.content ?? []).find(
    (block) => block.type === 'tool_use' && block.name === DRAFT_TOOL_NAME,
  );

  if (!call || typeof call.input !== 'object' || call.input === null) {
    throw new GenerationError(
      `The generation provider answered without calling ${DRAFT_TOOL_NAME}, so there is no draft ` +
        'to record. Run this step again.',
    );
  }

  const input = call.input as Record<string, unknown>;
  const drafts: Record<string, GeneratedDraft> = {};
  for (const kind of kinds) {
    const field = REVIEW_FIELD[kind];
    const value = input[field.name];

    if (field.shape === 'list') {
      // **A list is required to be a list.** A model that wrote its citations as a sentence — or
      // as a list of sentences — has not answered in the structure that was required, and the
      // honest thing is to fail the job rather than store prose as though it were citations
      // (scope prd 3.1.2). An *empty* list is a real answer and passes.
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'object' || entry === null)) {
        throw new GenerationError(
          `The generation provider answered the ${field.name} as something other than a list of ` +
            'entries, so there is nothing structured to record. Run this step again.',
        );
      }
      drafts[kind] = value as readonly ProposedCitation[];
      continue;
    }

    if (typeof value !== 'string' || value.trim() === '') {
      throw new GenerationError(
        `The generation provider called ${DRAFT_TOOL_NAME} without a ${field.name} in it.`,
      );
    }
    drafts[kind] = value.trim();
  }

  return { drafts: drafts as GeneratedDrafts, promptVersion: PROMPT_VERSION, spend: spendOf(response) };
}

/**
 * The body of a chapter segmentation.
 *
 * The same endpoint and the same forced-tool-call shape, a different instruction and a different
 * tool — which is the whole of what "one adapter, one vendor named in configuration" costs to serve
 * a second capability (project tdd 4.10).
 *
 * Exported so a unit test can assert what one segmentation asks for without a transport in the way.
 */
export function buildChapterRequestBody(request: ChapterRequest): Record<string, unknown> {
  return {
    model: MINIMAX_MODEL,
    max_tokens: MINIMAX_MAX_CHAPTER_TOKENS,
    system: CHAPTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildChapterUserPrompt(request) }],
    tools: [
      {
        name: CHAPTER_TOOL_NAME,
        description: 'Record the chapters of this teaching.',
        input_schema: CHAPTER_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: CHAPTER_TOOL_NAME },
  };
}

/**
 * A segmentation's response, turned into the port's answer.
 *
 * **A prose answer fails**, for the reason a prose draft does: a model that ignored `tool_choice`
 * produced no tool-use block, and salvaging boundaries out of free text would mean writing
 * timestamps nobody actually gave. The step fails, the pipeline halts and flags
 * ([3.21.2.3](docs/project/prd.md)), and — because a failed step writes nothing — the chapters a
 * teaching already has stay exactly as they were ([3.22.9](docs/project/prd.md)).
 *
 * **An empty list passes.** It is what a teaching too short to divide comes back as
 * ([3.22.4](docs/project/prd.md)), and treating it as a refusal would put a red row on the pipeline
 * screen for every short teaching in the back catalogue.
 *
 * **Nothing here checks the boundaries.** Whether they ascend, whether they land on a transcript
 * line and whether there are enough of them are the handler's questions — a vendor adapter is not
 * where a product rule is decided, and the handler is where the repairs are counted.
 */
export function mapChapterResponse(body: string): ChapterResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new GenerationError('The generation provider answered with something that is not JSON', {
      cause,
    });
  }

  const response = parsed as MiniMaxResponse;
  const call = (response.content ?? []).find(
    (block) => block.type === 'tool_use' && block.name === CHAPTER_TOOL_NAME,
  );

  if (!call || typeof call.input !== 'object' || call.input === null) {
    throw new GenerationError(
      `The generation provider answered without calling ${CHAPTER_TOOL_NAME}, so there are no ` +
        'chapters to record. Run this step again.',
    );
  }

  const proposed = (call.input as Record<string, unknown>)['chapters'];
  if (!Array.isArray(proposed)) {
    throw new GenerationError(
      'The generation provider answered the chapters as something other than a list, so there is ' +
        'nothing structured to record. Run this step again.',
    );
  }

  const chapters: ProposedChapter[] = [];
  for (const entry of proposed) {
    if (typeof entry !== 'object' || entry === null) {
      throw new GenerationError(
        'The generation provider answered with a chapter that is not an object. Run this step again.',
      );
    }
    const { startMs, title, summary } = entry as Record<string, unknown>;
    if (typeof startMs !== 'number' || typeof title !== 'string' || typeof summary !== 'string') {
      throw new GenerationError(
        'The generation provider answered with a chapter missing its start, title or summary. ' +
          'Run this step again.',
      );
    }
    // Trimmed here and refused nowhere: a title with a stray newline on it is the model being
    // untidy, not the model failing to answer in the structure that was required.
    chapters.push({ startMs, title: title.trim(), summary: summary.trim() });
  }

  return { chapters, promptVersion: CHAPTER_PROMPT_VERSION, spend: spendOf(response) };
}

/**
 * The five numbers a call cost, read off whichever response carried them.
 *
 * Lifted out of {@link mapResponse} when the second method arrived: both answers are billed the
 * same way by the same endpoint, and two copies of the arithmetic would be two places for a rate
 * change to be applied once.
 */
function spendOf(response: MiniMaxResponse): GenerationSpend {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    model: response.model ?? MINIMAX_MODEL,
    // The model id the provider echoes *is* the version it served, and it is the only version
    // statement in the response. Recorded as it came rather than parsed into parts.
    modelVersion: response.model ?? MINIMAX_MODEL,
    inputTokens,
    outputTokens,
    costUsd: costOf(inputTokens, outputTokens),
    requestId: response.id ?? '',
  };
}

/** What this call cost, to the cent-fraction the rates are quoted in. */
export function costOf(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * MINIMAX_USD_PER_MILLION_INPUT +
    (outputTokens / 1_000_000) * MINIMAX_USD_PER_MILLION_OUTPUT;
  return Number(usd.toFixed(6));
}

/** Only the parts of the response this adapter reads. The rest is the provider's business. */
interface MiniMaxResponse {
  readonly id?: string;
  readonly model?: string;
  readonly content?: readonly {
    readonly type?: string;
    readonly name?: string;
    readonly input?: unknown;
  }[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}
