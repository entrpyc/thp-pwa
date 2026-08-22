import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERATE_ADAPTER_FILES,
  GENERATE_PORT_FILE,
  GENERATE_PROMPT_FILE,
  checkGenerateBoundary,
  formatGenerateBoundaryViolations,
} from '../../tools/generate-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one generation module', () => {
  it('no application source outside the adapter names a generation provider', () => {
    expect(formatGenerateBoundaryViolations(checkGenerateBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually names one — otherwise this is vacuous', () => {
    // A pass above would otherwise be indistinguishable from "nothing generates anything at all".
    const [adapterFile] = GENERATE_ADAPTER_FILES;
    expect(adapterFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, adapterFile ?? ''), 'utf8');
    expect(source).toContain('api.minimax.io');
  });

  it('the port names no provider, which is the whole point of it', () => {
    const port = readFileSync(resolve(REPO_ROOT, GENERATE_PORT_FILE), 'utf8');
    expect(port.toLowerCase()).not.toContain('minimax');
  });

  it('the prompt names no provider either — it is about the artefacts, not about who writes them', () => {
    const prompt = readFileSync(resolve(REPO_ROOT, GENERATE_PROMPT_FILE), 'utf8');
    expect(prompt.toLowerCase()).not.toContain('minimax');
  });

  it('would report a second door, opened either way', () => {
    const violations = checkGenerateBoundary(REPO_ROOT, GENERATE_ADAPTER_FILES, [
      'tests/fixtures/leaky-generate',
    ]);
    const rules = new Set(violations.map((violation) => violation.rule));

    // An SDK import is one way in. A bare `fetch` at the provider's URL is the other, and it needs
    // no dependency — which is why this guard checks for a string as well as for an import.
    expect(rules).toContain('no-model-sdk');
    expect(rules).toContain('no-model-api');
    expect(violations.map((violation) => violation.detail)).toContain('@anthropic-ai/sdk');
    expect(formatGenerateBoundaryViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkGenerateBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/worker/src/generate/minimax.ts',
    );
  });

  it('refuses a vendor nobody has chosen, not merely the ones in use', () => {
    // The list includes providers this product does not use, so reaching for a different one is a
    // deliberate edit to a named list rather than merely a different URL.
    const violations = checkGenerateBoundary(REPO_ROOT, GENERATE_ADAPTER_FILES, [
      'tests/fixtures/leaky-generate',
    ]);
    expect(violations.map((violation) => violation.detail)).toContain('api.openai.com');
  });
});
