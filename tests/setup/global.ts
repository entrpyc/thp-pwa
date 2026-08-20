import { config as loadEnv } from 'dotenv';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@thp/db';
import { REPO_ROOT, buildNextApp, startNextServer, type RunningServer } from './next-server';

loadEnv({ path: `${REPO_ROOT}/.env`, quiet: true });

/** A host/port nothing listens on, so the "broken connection" case is genuinely broken. */
const UNREACHABLE_DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:1/nothing';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error(
      'Integration tests need a real Postgres. Set DATABASE_URL (see README.md, "Database") — ' +
        'they are deliberately not mocked, because the migration and pgvector checks would be ' +
        'meaningless against a fake.',
    );
  }

  await runMigrations({ url: databaseUrl });
  await buildNextApp();

  const servers: RunningServer[] = [];
  try {
    const primary = await startNextServer({ name: 'primary', databaseUrl });
    servers.push(primary);
    const broken = await startNextServer({
      name: 'broken-db',
      databaseUrl: UNREACHABLE_DATABASE_URL,
    });
    servers.push(broken);

    project.provide('apiBaseUrl', primary.baseUrl);
    project.provide('apiLogPath', primary.logPath);
    project.provide('brokenDbBaseUrl', broken.baseUrl);
    project.provide('databaseUrl', databaseUrl);
  } catch (error) {
    await Promise.all(servers.map((server) => server.stop()));
    throw error;
  }

  return async () => {
    await Promise.all(servers.map((server) => server.stop()));
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    apiBaseUrl: string;
    apiLogPath: string;
    brokenDbBaseUrl: string;
    databaseUrl: string;
  }
}
