import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every call to the generation provider goes through one module.**
 *
 * The same shape of rule as tools/asr-boundary.ts, and it exists for a sharper version of the same
 * reason. The generate-adapter row of
 * docs/epics/epic-core-listening/architecture.md § Key choices claims a deliberately *low reversal
 * cost* — swapping the model is one file — and this epic has already exercised that claim once: the
 * architecture names Claude and the operator chose MiniMax. A claim that has been cashed in should
 * be checkable rather than intended.
 *
 * Two ways to reach a provider, and both are checked. **Importing its SDK**, which is what the mail
 * and media guards look for; and **naming its API**, which those two do not need to because neither
 * Postgres nor S3 is reachable by URL from this code. A generation call is one `POST`, so a second
 * door needs no dependency at all — it needs a string.
 *
 * **The host list includes providers not in use.** That is the point: reaching for a different
 * vendor should require a deliberate edit to a named list here, not merely a different URL. A
 * provider genuinely absent from this list is one nobody has thought about, which is worth knowing.
 */

export interface GenerateBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-model-sdk' | 'no-model-api';
}

/** SDKs that speak to a text-generation provider. The candidates, not only the one in use. */
const MODEL_LIBRARIES = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
  '@google/genai',
  '@mistralai/mistralai',
  'cohere-ai',
  'ollama',
  'langchain',
  '@langchain/core',
  'ai',
];

/** Hosts that are a generation provider's API. A literal one of these is a second door. */
const MODEL_API_HOSTS = [
  'api.minimax.io',
  'api.minimaxi.com',
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.com',
  'openrouter.ai',
  'api.groq.com',
  'api.together.xyz',
];

/** The one file permitted to name the provider, repo-relative and posix. */
export const GENERATE_ADAPTER_FILES: readonly string[] = [
  'packages/worker/src/generate/minimax.ts',
];

/** The port the rest of the application calls instead. */
export const GENERATE_PORT_FILE = 'packages/worker/src/generate/generator.ts';

/** The prompt, which is about the artefacts and not about who writes them. */
export const GENERATE_PROMPT_FILE = 'packages/worker/src/generate/prompt.ts';

const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

const SOURCE_DIRS: readonly string[] = [
  'packages/worker/src',
  'packages/web/src',
  'packages/media/src',
  'packages/shared/src',
  'packages/db/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

/**
 * Blank out comment bodies, keeping line numbers intact.
 *
 * A doc comment explaining *why* one file may name the provider is documentation, not a second
 * door — and a rule that cannot tell the two apart teaches people to stop writing the explanation.
 *
 * The `[^:]` guard is load-bearing, exactly as it is in tools/asr-boundary.ts: what this rule looks
 * for is a **host**, and every host worth finding arrives inside an `https://`. Without it the
 * check blanks the very string it exists to catch, and passes.
 */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + blank(match.slice(prefix.length)));
}

export function checkGenerateBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = GENERATE_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): GenerateBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: GenerateBoundaryViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (allowed.has(relativeFile)) continue;

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          for (const match of text.matchAll(SPECIFIER_PATTERN)) {
            const specifier = match[1];
            if (specifier === undefined) continue;
            if (MODEL_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-model-sdk',
              });
            }
          }

          for (const host of MODEL_API_HOSTS) {
            if (text.includes(host)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: host,
                rule: 'no-model-api',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatGenerateBoundaryViolations(
  violations: readonly GenerateBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
