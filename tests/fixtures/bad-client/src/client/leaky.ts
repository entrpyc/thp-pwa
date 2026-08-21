// A deliberately violating client module. Never compiled or shipped — it exists so the
// import-boundary guard can be seen failing. A guard nobody has watched fail is not a guard.
import { readFileSync } from 'node:fs';
import { getDatabase } from '@thp/db';
import { mediaStore } from '@thp/media';
import postgres from 'postgres';
import { SERVER_ONLY_SECRET } from '../server/secret';
import { somethingElse } from '@/server/api/route';

export async function loadRecordings() {
  const rows = await getDatabase().sql`select 1`;
  const response = await fetch('/api/v1/recordings');
  return { rows, response, readFileSync, postgres, SERVER_ONLY_SECRET, somethingElse, mediaStore };
}
