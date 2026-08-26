import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **Every call to the transcription provider goes through one module.**
 *
 * The same shape of rule as "every outbound message goes through one module"
 * (tools/mail-boundary.ts) and "every call to the object store goes through one module"
 * (tools/media-boundary.ts), and it exists for the reason those do. The managed-ASR row of
 * core-listening scope tdd § Key choices claims a deliberately *low reversal
 * cost* — swapping providers is one file — and that claim is only true while one file is the only
 * place a provider is named.
 *
 * Two ways to reach a provider, and both are checked. **Importing its SDK**, which is what the mail
 * and media guards look for; and **naming its API**, which those two do not need to look for
 * because neither Postgres nor S3 is reachable by URL from this code. Deepgram is one `POST`, so a
 * second door needs no dependency at all — it needs a string.
 */

export interface AsrBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-asr-sdk' | 'no-asr-api';
}

/** SDKs that speak to a speech-to-text provider. The candidates, not only the one in use. */
const ASR_LIBRARIES = [
  '@deepgram/sdk',
  'assemblyai',
  'openai',
  '@google-cloud/speech',
  '@aws-sdk/client-transcribe',
  '@azure/cognitiveservices-speech-sdk',
  'microsoft-cognitiveservices-speech-sdk',
];

/** Hosts that are a transcription provider's API. A literal one of these is a second door. */
const ASR_API_HOSTS = [
  'api.deepgram.com',
  'api.assemblyai.com',
  'api.openai.com',
  'speech.googleapis.com',
];

/** The one file permitted to name the provider, repo-relative and posix. */
export const ASR_ADAPTER_FILES: readonly string[] = ['packages/worker/src/asr/deepgram.ts'];

/** The port the rest of the application calls instead. */
export const ASR_PORT_FILE = 'packages/worker/src/asr/transcriber.ts';

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
 * The `[^:]` guard is load-bearing here in a way it is not in tools/import-boundary.ts: what this
 * rule looks for is a **host**, and every host worth finding arrives inside a `https://`. Without
 * it the check blanks the very string it exists to catch, and passes.
 */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix + blank(match.slice(prefix.length)));
}

export function checkAsrBoundary(
  repoRoot: string,
  allowedFiles: readonly string[] = ASR_ADAPTER_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
): AsrBoundaryViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: AsrBoundaryViolation[] = [];

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
            if (ASR_LIBRARIES.some((name) => isPackage(specifier, name))) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: specifier,
                rule: 'no-asr-sdk',
              });
            }
          }

          for (const host of ASR_API_HOSTS) {
            if (text.includes(host)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: host,
                rule: 'no-asr-api',
              });
            }
          }
        });
    }
  }

  return violations;
}

export function formatAsrBoundaryViolations(
  violations: readonly AsrBoundaryViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
