import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * The style-guide guard.
 *
 * There is no PNG for the sign-in screen, so "built from its design reference" cannot be checked
 * against pixels. It is checked against **tokens** instead, in two halves:
 *
 * 1. The token file and the guide's *Quick token block* declare the same names with the same
 *    values — so the two cannot drift silently.
 * 2. No other stylesheet declares a raw hex colour, a pixel radius or an ad-hoc spacing value — so
 *    "composed from the guide" means something the moment there is nothing to compare against.
 */

export type TokenMap = ReadonlyMap<string, string>;

const CUSTOM_PROPERTY = /(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)/g;

/** Whitespace-insensitive, so `rgba(255,255,255,0.08)` and `rgba(255, 255, 255, 0.08)` compare equal. */
function normaliseValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
}

export function parseCustomProperties(css: string): TokenMap {
  const tokens = new Map<string, string>();
  for (const match of css.matchAll(CUSTOM_PROPERTY)) {
    const [, name, value] = match;
    if (name && value !== undefined) tokens.set(name, normaliseValue(value));
  }
  return tokens;
}

/** The ```css block under `## Quick token block` — the guide's own statement of the token layer. */
export function quickTokenBlock(styleGuideMarkdown: string): string {
  const section = styleGuideMarkdown.split(/^##\s+Quick token block\s*$/m)[1];
  if (section === undefined) throw new Error('style-guide.md has no "## Quick token block" heading');
  const fenced = /```css\s*\n([\s\S]*?)```/.exec(section);
  if (!fenced?.[1]) throw new Error('the Quick token block section has no ```css fence');
  return fenced[1];
}

export interface TokenDifference {
  readonly name: string;
  readonly inGuide: string | null;
  readonly inCss: string | null;
}

export function diffTokens(guide: TokenMap, css: TokenMap): TokenDifference[] {
  const names = [...new Set([...guide.keys(), ...css.keys()])].sort();
  return names
    .filter((name) => guide.get(name) !== css.get(name))
    .map((name) => ({ name, inGuide: guide.get(name) ?? null, inCss: css.get(name) ?? null }));
}

// ---------------------------------------------------------------------------------------------

export interface StyleViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'raw-colour' | 'raw-radius' | 'raw-spacing' | 'token-declared-outside-token-file';
  readonly detail: string;
}

const SPACING_PROPERTIES =
  /(?:^|[;{\s])(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?\s*:\s*([^;}]+)/i;
const RADIUS_PROPERTY = /(?:^|[;{\s])border(?:-[a-z]+)?-radius\s*:\s*([^;}]+)/i;
const HEX_COLOUR = /#[0-9A-Fa-f]{3,8}\b/;
const FUNCTIONAL_COLOUR = /\b(?:rgb|rgba|hsl|hsla|oklch|lab)\(/i;
const PX_LENGTH = /\b\d*\.?\d+px\b/;

function cssFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...cssFiles(full));
    else if (entry.endsWith('.css')) found.push(full);
  }
  return found;
}

/** Every stylesheet the check covers, repo-relative to `srcDir`. Exported so a test can see it. */
export function listStylesheets(srcDir: string): string[] {
  const root = resolve(srcDir);
  return cssFiles(root)
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
}

function withoutComments(css: string): string {
  // Replace comment bodies with spaces so line numbers and offsets survive.
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Every stylesheet under `srcDir` apart from the token file must compose from tokens. Media-query
 * conditions are exempt: a breakpoint is not a spacing value, and no token expresses one.
 */
export function checkStyleTokens(srcDir: string, tokenFile: string): StyleViolation[] {
  const root = resolve(srcDir);
  const tokenPath = resolve(tokenFile);
  const violations: StyleViolation[] = [];

  for (const file of cssFiles(root)) {
    if (resolve(file) === tokenPath) continue;
    const relativeFile = relative(root, file).split(sep).join('/');

    withoutComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((raw, index) => {
        const line = index + 1;
        const add = (rule: StyleViolation['rule'], detail: string) =>
          violations.push({ file: relativeFile, line, rule, detail });

        if (/^\s*@(?:media|container|supports)\b/.test(raw)) return;

        if (/(--[A-Za-z0-9-]+)\s*:/.test(raw)) {
          add('token-declared-outside-token-file', raw.trim());
        }

        // Colours: only inside a var() reference, never spelled out.
        const withoutVars = raw.replace(/var\([^)]*\)/g, '');
        if (HEX_COLOUR.test(withoutVars)) add('raw-colour', raw.trim());
        else if (FUNCTIONAL_COLOUR.test(withoutVars)) add('raw-colour', raw.trim());

        const radius = RADIUS_PROPERTY.exec(raw);
        if (radius?.[1] && (PX_LENGTH.test(radius[1]) || /%/.test(radius[1]))) {
          add('raw-radius', raw.trim());
        }

        const spacing = SPACING_PROPERTIES.exec(raw);
        if (spacing?.[2] && PX_LENGTH.test(spacing[2])) add('raw-spacing', raw.trim());
      });
  }

  return violations;
}

export function formatStyleViolations(violations: readonly StyleViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}

// ---------------------------------------------------------------------------------------------

/**
 * The same rule, applied to TypeScript.
 *
 * Step 3 introduced a surface no stylesheet can reach: **the invitation email**. Mail clients do
 * not support CSS custom properties and several strip `<style>` blocks entirely, so the template
 * has to inline literal values — which means the guard above, scanning only `.css`, would not see
 * the one place in the codebase where a raw colour actually appears.
 *
 * So the rule is answered rather than dodged. This scans application TypeScript for spelled-out
 * colours and exempts a **named list of files** rather than a pattern: the exception is one path
 * somebody had to add, not a shape anything can grow into.
 */
export interface InlineColourViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'raw-colour-in-source';
  readonly detail: string;
}

/** The only files permitted to spell a colour out, repo-relative and posix. */
export const COLOUR_LITERAL_FILES: readonly string[] = [
  'packages/web/src/server/mail/theme.ts',
];

/**
 * Six or eight hex digits, or three/four shorthand — anchored so it does not fire on the hex in a
 * SHA-256 example or in an id. A colour literal in source is written as a string, so the pattern
 * only looks inside quotes.
 */
const QUOTED_HEX_COLOUR = /['"`]#[0-9A-Fa-f]{3,8}['"`]/;
const QUOTED_FUNCTIONAL_COLOUR = /['"`][^'"`]*\b(?:rgb|rgba|hsl|hsla|oklch|lab)\([^'"`]*['"`]/i;

export function checkColourLiterals(
  repoRoot: string,
  allowedFiles: readonly string[] = COLOUR_LITERAL_FILES,
  sourceDirs: readonly string[] = ['packages/web/src', 'packages/shared/src', 'packages/worker/src'],
): InlineColourViolation[] {
  const root = resolve(repoRoot);
  const allowed = new Set(allowedFiles);
  const violations: InlineColourViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = relative(root, file).split(sep).join('/');
      if (allowed.has(relativeFile)) continue;

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((raw, index) => {
          if (QUOTED_HEX_COLOUR.test(raw) || QUOTED_FUNCTIONAL_COLOUR.test(raw)) {
            violations.push({
              file: relativeFile,
              line: index + 1,
              rule: 'raw-colour-in-source',
              detail: raw.trim(),
            });
          }
        });
    }
  }

  return violations;
}

export function formatColourLiteralViolations(
  violations: readonly InlineColourViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
