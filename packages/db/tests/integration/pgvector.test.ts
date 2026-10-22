import { afterAll, describe, expect, it, inject } from 'vitest';
import postgres from 'postgres';
import { EMBEDDING_DIMENSIONS } from '@thp/shared';

/**
 * **pgvector, installed on the instance and enabled in the migrated database.**
 *
 * This file used to assert the opposite of its second half — *available but not enabled* — and
 * the flip is deliberate: the embedding foundation (project tdd 4.4) is the epic that enables it,
 * by `create extension if not exists vector` at the top of migration `0028_embeddings`. The
 * database injected here is the suite's own, migrated from empty by tests/setup/global.ts, so
 * "enabled" is asserted about what the migrations produce and not about what a developer ran by
 * hand.
 */

const sql = postgres(inject('databaseUrl'), { max: 1, onnotice: () => {} });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('the vector extension is available and enabled', () => {
  it('is installed on the instance as an available extension', async () => {
    const rows = await sql<{ name: string }[]>`
      select name from pg_available_extensions where name = 'vector'
    `;
    expect(
      rows.map((row) => row.name),
      'pgvector is not installed on this Postgres instance. The single-datastore decision depends ' +
        'on vectors and ACL data sharing a database — see project tdd 4.4.',
    ).toEqual(['vector']);
  });

  it('is enabled in the migrated database — migration 0028_embeddings does it', async () => {
    const rows = await sql<{ extname: string }[]>`
      select extname from pg_extension where extname = 'vector'
    `;
    expect(rows.map((row) => row.extname)).toEqual(['vector']);
  });

  it('types the embedding column at the shared width, so an adapter of another width is refused', async () => {
    const [row] = await sql<{ typmod: number }[]>`
      select atttypmod as typmod
      from pg_attribute
      where attrelid = 'public.embedding'::regclass and attname = 'embedding'
    `;
    // For `vector(n)` the type modifier is `n` itself.
    expect(row?.typmod).toBe(EMBEDDING_DIMENSIONS);
  });

  it('indexes the vectors with HNSW under cosine distance', async () => {
    const [row] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'embedding' and indexname = 'embedding_vector_hnsw_idx'
    `;
    expect(row?.indexdef).toMatch(/USING hnsw/);
    expect(row?.indexdef).toMatch(/vector_cosine_ops/);
  });
});
