import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTE_PRIVACY_EXEMPT_FILES,
  NOTE_PRIVACY_MODULE_FILES,
  checkNotePrivacy,
  formatNotePrivacyViolations,
} from '../../tools/note-privacy';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * **The Privacy NFR, as something a build can fail on.**
 *
 * "A private note is excluded by the query that reads notes, not by the interface that renders
 * them" is otherwise a sentence in a document. Every assertion below is about one of the two ways
 * it stops being true: somebody writes the condition a second time, or nobody writes it at all.
 */
describe('the private-note condition is written once', () => {
  it('holds across the repository', () => {
    expect(formatNotePrivacyViolations(checkNotePrivacy(REPO_ROOT))).toBe('');
  });

  it('would report a second statement of it, over either half and in either spelling', () => {
    const violations = checkNotePrivacy(REPO_ROOT, NOTE_PRIVACY_MODULE_FILES, [
      'tests/fixtures/leaky-note-privacy',
    ]);
    const details = violations.map((violation) => violation.detail);

    expect(details).toContain('comparison over note.visibility');
    expect(details).toContain('comparison over note.authorId');
    expect(details).toContain("visibility = 'public' in SQL");
    expect(details).toContain('author_id = … in SQL');
    expect(formatNotePrivacyViolations(violations)).toContain('caller.ts');
    expect(violations.every((violation) => violation.line > 0)).toBe(true);
    expect(violations.some((v) => v.rule === 'no-note-privacy-predicate')).toBe(true);
  });

  it('reports the owning module too when it is not the exempt one', () => {
    // The exemption is a named path, not a shape — so removing the name is enough to make the real
    // file fail, which is what "one place, deliberately" has to mean.
    const violations = checkNotePrivacy(REPO_ROOT, [], undefined, NOTE_PRIVACY_EXEMPT_FILES);
    expect(violations.map((violation) => violation.file)).toContain('packages/db/src/notes.ts');
  });

  it('names schema.ts as the only other exemption, and for a reason that is not a read', () => {
    // A widened exemption list is how a guard quietly stops guarding. Stating it here makes adding
    // a third file an edit somebody has to justify rather than a line nobody notices.
    expect([...NOTE_PRIVACY_EXEMPT_FILES]).toEqual(['packages/db/src/schema.ts']);
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/src/schema.ts'), 'utf8');
    // What it is exempt *for*: a check constraint on what may be stored. It issues no query, and
    // the guard would be reporting the table's own rule about replies, not a read of anybody's
    // notes.
    expect(schema).toContain('note_reply_is_public');
    expect(schema).not.toContain('listNotesForReader');
  });
});

describe('and the module that owns it actually states it', () => {
  it('fails when the owning module stops stating either half of the condition', () => {
    // Without this, a pass above would be indistinguishable from "nothing checks privacy at all" —
    // deleting the condition from `notes.ts` would make the repository *cleaner* by the rule
    // above, which is the failure this half exists to make impossible.
    const violations = checkNotePrivacy(REPO_ROOT, ['tests/fixtures/leaky-note-privacy/silent.ts']);
    const unstated = violations.filter((one) => one.rule === 'unstated-privacy-condition');

    expect(unstated.map((one) => one.detail)).toEqual([
      'states no predicate over note.visibility',
      'states no predicate over note.author_id',
    ]);
  });

  it('passes for the real module, which states both halves', () => {
    const violations = checkNotePrivacy(REPO_ROOT);
    expect(violations.filter((one) => one.rule === 'unstated-privacy-condition')).toEqual([]);

    const [ownerFile] = NOTE_PRIVACY_MODULE_FILES;
    expect(ownerFile).toBeDefined();
    const source = readFileSync(resolve(REPO_ROOT, ownerFile ?? ''), 'utf8');
    expect(source).toContain("eq(note.visibility, 'public')");
    expect(source).toContain('eq(note.authorId, readerId)');
  });
});
