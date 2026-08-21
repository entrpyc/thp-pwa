import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '@thp/db';
import { interfaceFields, toSnakeCase } from '../../tools/segment-shape';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SHARED_SEGMENT_FILE = 'packages/shared/src/segment.ts';

const sharedSource = readFileSync(resolve(REPO_ROOT, SHARED_SEGMENT_FILE), 'utf8');

/** The shared type's fields, as the column names they correspond to. */
function expectedColumns(): string[] {
  return interfaceFields(sharedSource, 'Segment').map(toSnakeCase).sort();
}

/** The table's real column names, read off the Drizzle table rather than off its source. */
function actualColumns(): string[] {
  return Object.values(getTableColumns(schema.segment))
    .map((column) => column.name)
    .sort();
}

describe('the segment table is the shared Segment type', () => {
  it('reads fields off the shared type at all — otherwise every assertion here is vacuous', () => {
    // Seven fields, and the parse can see them. A silently empty parse would make "the two agree"
    // pass for a table that agreed with nothing.
    expect(interfaceFields(sharedSource, 'Segment')).toEqual([
      'id',
      'transcriptId',
      'startMs',
      'endMs',
      'text',
      'correctedAt',
      'correctedByUserId',
    ]);
  });

  it('carries exactly the columns the type declares, and no others', () => {
    // Matched rather than re-invented. A column the type does not have — an embedding, a speaker,
    // a confidence — is the table and the contract quietly becoming two shapes, and this is where
    // that stops. docs/epics/epic-core-listening/architecture.md § Extension points names the
    // `ALTER TABLE` that adds an embedding, and it belongs to a later epic.
    expect(actualColumns()).toEqual(expectedColumns());
  });

  it('would report a field the table does not have', () => {
    const withExtra = sharedSource.replace(
      '  readonly text: string;',
      '  readonly text: string;\n  readonly speakerLabel: string;',
    );
    expect(withExtra).not.toBe(sharedSource);
    expect(interfaceFields(withExtra, 'Segment').map(toSnakeCase).sort()).not.toEqual(
      actualColumns(),
    );
  });

  it('names offsets in milliseconds as integers, start inclusive and end exclusive', () => {
    const columns = getTableColumns(schema.segment);
    expect(columns.startMs.getSQLType()).toBe('integer');
    expect(columns.endMs.getSQLType()).toBe('integer');
    // The shared type is where inclusive/exclusive is stated, and it is the only statement of it.
    expect(sharedSource).toContain('Inclusive start offset');
    expect(sharedSource).toContain('Exclusive end offset');
  });
});
