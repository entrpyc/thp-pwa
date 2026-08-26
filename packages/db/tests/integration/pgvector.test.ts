import { afterAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';

const sql = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('the vector extension is available but not enabled', () => {
  it('is installed on the instance as an available extension', async () => {
    const rows = await sql<{ name: string }[]>`
      select name from pg_available_extensions where name = 'vector'
    `;
    expect(
      rows.map((row) => row.name),
      'pgvector is not installed on this Postgres instance. The single-datastore decision depends ' +
        'on vectors and ACL data sharing a database — see core-listening scope tdd, "Primary datastore".',
    ).toEqual(['vector']);
  });

  it('is not enabled — CREATE EXTENSION belongs to a later epic', async () => {
    const rows = await sql<{ extname: string }[]>`
      select extname from pg_extension where extname = 'vector'
    `;
    expect(rows).toEqual([]);
  });
});
