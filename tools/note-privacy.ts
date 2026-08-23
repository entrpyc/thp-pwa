import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { walkFiles } from './fs-walk';

/**
 * **The private-note condition is written once.**
 *
 * The Privacy NFR says a private note is *"excluded by the query that reads notes, not by the
 * interface that renders them"* (active-scope prd 6). That is a claim, and this is what makes it
 * checkable rather than reviewed: a predicate over `note.visibility` or `note.author_id` written
 * anywhere but `packages/db/src/notes.ts` fails the build, and the owning module is asserted to
 * actually state it — so a pass can never quietly mean "nothing checks privacy at all".
 *
 * **It ships beside tools/visibility-boundary.ts rather than inside it.** That guard is about
 * recording publication and six read paths already depend on it; folding a second concept into it
 * would put this scope's regression risk onto a rule this scope does not touch. Two guards, one
 * concept each.
 *
 * **What is forbidden is a query predicate** — a Drizzle comparison over the column, or the SQL
 * spelling of one. Three things are deliberately not forbidden, because none of them decides which
 * rows a reader gets:
 *
 * - **Rendering a note's visibility.** The **Private** marker (active-scope prd 3.2.2) is a badge
 *   drawn from a field the API already decided to send, and the client holds no decision.
 * - **Narrowing an already-answered list.** The All / Public / Mine filter (3.2.3) chooses what is
 *   *listed* out of what the query already returned; it never reaches a row the reader may not see.
 * - **Storing a visibility.** `packages/db/src/schema.ts` is exempt below for the same reason
 *   visibility-boundary exempts a write: its `note_reply_is_public` check constraint decides what
 *   may be *stored*, never who may read it.
 */

export interface NotePrivacyViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
  readonly rule: 'no-note-privacy-predicate' | 'unstated-privacy-condition';
}

/**
 * The one module permitted to state it, repo-relative and posix — and `schema.ts`, which declares
 * the table's own constraints and issues no query at all.
 */
export const NOTE_PRIVACY_MODULE_FILES: readonly string[] = ['packages/db/src/notes.ts'];
export const NOTE_PRIVACY_EXEMPT_FILES: readonly string[] = ['packages/db/src/schema.ts'];

/**
 * A predicate over either half of the condition, in both spellings this codebase writes queries in.
 *
 * The two halves are labelled separately because {@link checkNotePrivacy} needs them separately:
 * outside the owning module either one is a violation, and inside it **both** must be present or
 * the condition is not being stated.
 */
const PREDICATE_PATTERNS: readonly {
  readonly label: string;
  readonly half: 'visibility' | 'author';
  readonly pattern: RegExp;
}[] = [
  {
    label: 'comparison over note.visibility',
    half: 'visibility',
    pattern: /\b(?:eq|ne|inArray|notInArray)\s*\(\s*[\w.]*\bvisibility\b/,
  },
  {
    label: 'comparison over note.authorId',
    half: 'author',
    pattern: /\b(?:eq|ne|inArray|notInArray)\s*\(\s*[\w.]*\bauthorId\b/,
  },
  {
    label: "visibility = 'public' in SQL",
    half: 'visibility',
    // The lookbehind keeps an assignment out of it: `const visibility = 'private'` in a composer is
    // a value being chosen, not rows being selected.
    pattern: /(?<!\b(?:const|let|var)\s)\bvisibility\}?\s*(?:=(?!=)|<>|!=(?!=))\s*'(?:public|private)'/,
  },
  {
    label: 'author_id = … in SQL',
    half: 'author',
    pattern: /\bauthor_id\}?\s*(?:=(?!=)|<>|!=(?!=)|\bin\b)/i,
  },
];

const SOURCE_DIRS: readonly string[] = [
  'packages/db/src',
  'packages/web/src',
  'packages/worker/src',
  'packages/shared/src',
];

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/** Blank out comment bodies, keeping line numbers. Explaining the rule is not breaking it. */
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) =>
      prefix + blank(match.slice(prefix.length)),
    );
}

/**
 * Both directions of "written once": nobody else states it, **and** the owning module does.
 *
 * The second half is what stops this from being a rule that passes hardest when the feature is
 * missing. It uses the same patterns as the first — the shape that is a violation everywhere else
 * is the shape that is required here — and it wants both halves of the condition, because
 * `visibility = 'public'` on its own returns nobody their own private notes and
 * `author_id = :me` on its own returns nobody anybody else's public ones.
 */
export function checkNotePrivacy(
  repoRoot: string,
  ownerFiles: readonly string[] = NOTE_PRIVACY_MODULE_FILES,
  sourceDirs: readonly string[] = SOURCE_DIRS,
  exemptFiles: readonly string[] = NOTE_PRIVACY_EXEMPT_FILES,
): NotePrivacyViolation[] {
  const root = resolve(repoRoot);
  const owners = new Set(ownerFiles);
  const exempt = new Set(exemptFiles);
  const violations: NotePrivacyViolation[] = [];

  for (const dir of sourceDirs) {
    for (const file of walkFiles(resolve(root, dir))) {
      const relativeFile = toPosix(relative(root, file));
      if (owners.has(relativeFile) || exempt.has(relativeFile)) continue;

      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          for (const { label, pattern } of PREDICATE_PATTERNS) {
            if (pattern.test(text)) {
              violations.push({
                file: relativeFile,
                line: index + 1,
                detail: label,
                rule: 'no-note-privacy-predicate',
              });
            }
          }
        });
    }
  }

  for (const ownerFile of ownerFiles) {
    const source = withoutComments(readFileSync(resolve(root, ownerFile), 'utf8'));
    for (const half of ['visibility', 'author'] as const) {
      const states = PREDICATE_PATTERNS.filter((one) => one.half === half).some((one) =>
        source.split('\n').some((text) => one.pattern.test(text)),
      );
      if (!states) {
        violations.push({
          file: ownerFile,
          line: 1,
          detail: `states no predicate over note.${half === 'author' ? 'author_id' : 'visibility'}`,
          rule: 'unstated-privacy-condition',
        });
      }
    }
  }

  return violations;
}

export function formatNotePrivacyViolations(
  violations: readonly NotePrivacyViolation[],
): string {
  return violations.map((v) => `${v.file}:${v.line}  [${v.rule}]  ${v.detail}`).join('\n');
}
