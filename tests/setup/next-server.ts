import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const WEB_DIR = resolve(REPO_ROOT, 'packages', 'web');
export const LOG_DIR = resolve(REPO_ROOT, '.tmp', 'logs');

const require = createRequire(import.meta.url);

export interface RunningServer {
  readonly baseUrl: string;
  readonly logPath: string;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((done) => {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
        'close',
        () => done(),
      );
    });
  } else {
    child.kill('SIGTERM');
  }
  await new Promise((done) => setTimeout(done, 250));
}

export interface StartOptions {
  readonly name: string;
  readonly databaseUrl: string;
  /** Extra environment for the server process. */
  readonly env?: Record<string, string>;
  readonly readyTimeoutMs?: number;
}

/**
 * Produce the production build the integration servers serve.
 *
 * Why not `next dev`: the suite needs two servers at once — one wired to a working database and one
 * to a broken one — and Next refuses a second `next dev` for the same project directory. Building
 * once and starting two production servers sidesteps that, and has the better property anyway: the
 * tests exercise the artefact that actually ships.
 */
export async function buildNextApp(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = resolve(LOG_DIR, 'build.log');
  rmSync(logPath, { force: true });
  const log = createWriteStream(logPath, { flags: 'a' });

  const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
    cwd: WEB_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Inlined into the client bundle at build time. The integration tests build their own URLs,
      // so the value only has to exist.
      NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:0',
      NEXT_TELEMETRY_DISABLED: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const code: number = await new Promise((done) => child.on('close', (value) => done(value ?? 1)));
  log.end();
  if (code !== 0) throw new Error(`next build failed (${code}); see ${logPath}`);
}

/**
 * Start a real Next.js server and wait until it answers. Integration tests talk to this over HTTP —
 * they never import a route handler, because importing one would not prove the route exists.
 */
export async function startNextServer(options: StartOptions): Promise<RunningServer> {
  mkdirSync(LOG_DIR, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = resolve(LOG_DIR, `${options.name}.log`);
  rmSync(logPath, { force: true });
  const log = createWriteStream(logPath, { flags: 'a' });

  const child = spawn(
    process.execPath,
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '--port',
      String(port),
      '--hostname',
      '127.0.0.1',
    ],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: options.databaseUrl,
        NEXT_PUBLIC_API_ORIGIN: baseUrl,
        NEXT_TELEMETRY_DISABLED: '1',
        FORCE_COLOR: '0',
        // The diagnostics routes are 404 in production unless this is set — see
        // packages/web/src/server/api/diagnostics.ts. The suite needs them; deployments do not.
        ENABLE_DIAGNOSTIC_ROUTES: 'true',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const deadline = Date.now() + (options.readyTimeoutMs ?? 180_000);
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`[${options.name}] next start exited early (${child.exitCode}); see ${logPath}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 200) {
        await response.arrayBuffer();
        return {
          baseUrl,
          logPath,
          stop: async () => {
            await killTree(child);
            log.end();
          },
        };
      }
      lastError = `health responded ${response.status}`;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((done) => setTimeout(done, 500));
  }

  await killTree(child);
  log.end();
  throw new Error(`[${options.name}] never became ready: ${lastError}. See ${logPath}`);
}
