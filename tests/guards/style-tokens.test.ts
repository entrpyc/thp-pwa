import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkStyleTokens,
  diffTokens,
  formatStyleViolations,
  listStylesheets,
  parseCustomProperties,
  quickTokenBlock,
} from '../../tools/style-tokens';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const STYLE_GUIDE = resolve(REPO_ROOT, 'docs/design referencess png/style-guide.md');
const WEB_SRC = resolve(REPO_ROOT, 'packages/web/src');
const TOKEN_FILE = resolve(WEB_SRC, 'app/tokens.css');

const guideTokens = parseCustomProperties(quickTokenBlock(readFileSync(STYLE_GUIDE, 'utf8')));
const cssTokens = parseCustomProperties(readFileSync(TOKEN_FILE, 'utf8'));

describe('the token layer is the style guide', () => {
  it('reads a substantial token block from the guide', () => {
    // Guards against a parser change quietly reducing the comparison to nothing.
    expect(guideTokens.size).toBeGreaterThan(20);
  });

  it('declares exactly the guide’s Quick token block, name for name and value for value', () => {
    const differences = diffTokens(guideTokens, cssTokens);
    expect(
      differences
        .map((d) => `${d.name}: guide=${d.inGuide ?? '(absent)'} css=${d.inCss ?? '(absent)'}`)
        .join('\n'),
    ).toBe('');
  });

  it('would report a value that drifted', () => {
    const drifted = new Map(cssTokens);
    drifted.set('--color-primary', '#000000');
    expect(diffTokens(guideTokens, drifted).map((d) => d.name)).toEqual(['--color-primary']);
  });

  it('would report a token the guide has and the stylesheet does not', () => {
    const missing = new Map(cssTokens);
    missing.delete('--radius-pill');
    expect(diffTokens(guideTokens, missing).map((d) => d.name)).toEqual(['--radius-pill']);
  });
});

describe('no component declares what a token already covers', () => {
  it('covers the component stylesheets by name, not just the token file', () => {
    // The check below is only meaningful if it actually reads the screens' own stylesheets. Naming
    // them here is what stops "no violations" from meaning "nothing was read".
    const sheets = listStylesheets(WEB_SRC);
    expect(sheets).toContain('app/tokens.css');
    expect(sheets).toContain('app/globals.css');
    expect(sheets).toContain('app/sign-in/sign-in.module.css');
    expect(sheets).toContain('app/home.module.css');

    // And the token file really is the one exception — scanned like any other when not excluded.
    const seeded = checkStyleTokens(WEB_SRC, resolve(WEB_SRC, 'nothing.css'));
    expect(seeded.some((violation) => violation.file === 'app/tokens.css')).toBe(true);
  });

  it('holds across every stylesheet but the token file', () => {
    expect(formatStyleViolations(checkStyleTokens(WEB_SRC, TOKEN_FILE))).toBe('');
  });

  it('reports a raw hex colour, a pixel radius and an ad-hoc spacing value', () => {
    const fixture = resolve(REPO_ROOT, 'tests/fixtures/untokenised-styles');
    const violations = checkStyleTokens(fixture, resolve(fixture, 'nothing.css'));
    const rules = new Set(violations.map((violation) => violation.rule));

    expect(rules).toContain('raw-colour');
    expect(rules).toContain('raw-radius');
    expect(rules).toContain('raw-spacing');
    expect(rules).toContain('token-declared-outside-token-file');
    expect(formatStyleViolations(violations)).toContain('offender.module.css');
  });
});
