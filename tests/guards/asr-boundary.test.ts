import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASR_ADAPTER_FILES,
  ASR_PORT_FILE,
  checkAsrBoundary,
  formatAsrBoundaryViolations,
} from '../../tools/asr-boundary';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('one transcription module', () => {
  it('no application source outside the adapter names a transcription provider', () => {
    expect(formatAsrBoundaryViolations(checkAsrBoundary(REPO_ROOT))).toBe('');
  });

  it('the file that is allowed to actually names one — otherwise this is vacuous', () => {
    // A pass above would otherwise be indistinguishable from "nothing transcribes anything at all".
    const [adapterFile] = ASR_ADAPTER_FILES;
    expect(adapterFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, adapterFile ?? ''), 'utf8');
    expect(source).toContain('api.deepgram.com');
  });

  it('the port names no provider, which is the whole point of it', () => {
    const port = readFileSync(resolve(REPO_ROOT, ASR_PORT_FILE), 'utf8');
    expect(port.toLowerCase()).not.toContain('deepgram');
  });

  it('would report a second door, opened either way', () => {
    const violations = checkAsrBoundary(REPO_ROOT, ASR_ADAPTER_FILES, ['tests/fixtures/leaky-asr']);
    const rules = new Set(violations.map((violation) => violation.rule));

    // An SDK import is one way in. A bare `fetch` at the provider's URL is the other, and it needs
    // no dependency — which is why this guard checks for a string as well as for an import.
    expect(rules).toContain('no-asr-sdk');
    expect(rules).toContain('no-asr-api');
    expect(violations.map((violation) => violation.detail)).toContain('@deepgram/sdk');
    expect(formatAsrBoundaryViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
  });

  it('reports the adapter too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one file, deliberately" has to mean.
    const violations = checkAsrBoundary(REPO_ROOT, []);
    expect(violations.map((violation) => violation.file)).toContain(
      'packages/worker/src/asr/deepgram.ts',
    );
  });
});
