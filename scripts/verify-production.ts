/**
 * `npm run verify:production` — **is the box in the state it is supposed to be in?**
 *
 * The test for Story 7's infrastructure criteria. Almost nothing this story delivers is assertable
 * by `npm test`, because the thing under test is a machine that does not exist in CI — so the
 * criteria name this script, and this script is what the operator runs after each group of the
 * deployment lands.
 *
 * **It reports rather than repairs.** Every check reads; none writes, restarts or reconfigures. A
 * script that fixed what it found would be a second, undocumented way of configuring the host, and
 * the runbook in README.md is meant to be the only one.
 *
 * Three ways to run it:
 *
 * - `npm run verify:production` — every check, on the box.
 * - `npm run verify:production -- --remote-only` — the checks that need nothing but HTTP, so they
 *   can be run from anywhere, including a machine that is not the server.
 * - `npm run verify:production -- --kill-drill` / `-- --smoke --audio=<path>` — the two checks that
 *   act rather than read, run only when asked for by name. `--smoke` spends real money.
 *
 * Every check prints its own line and the run continues past a failure, so one run diagnoses the
 * box rather than bisecting it. The exit code is non-zero if anything failed.
 */

import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';
import { readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPO_ROOT = resolve(import.meta.dirname, '..');

// =================================================================================================
// Pure parsers.
//
// Separated from the checks that call them, and exported, because they are the only part of this
// script a test can reach: tests/unit/verify-production.test.ts drives each one against captured
// output from the real command. The alternative is debugging a `pm2 jlist` shape at 2am on the box.
// =================================================================================================

export interface Pm2App {
  readonly name: string;
  readonly status: string;
  readonly execMode: string;
  readonly instances: number;
  readonly restarts: number;
  readonly pid: number;
}

interface RawPm2Entry {
  name?: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    exec_mode?: string;
    instances?: number;
    restart_time?: number;
  };
}

/** `pm2 jlist` — the fields that decide whether supervision is configured the way the story needs. */
export function parsePm2List(json: string): Pm2App[] {
  return (JSON.parse(json) as RawPm2Entry[]).map((entry) => ({
    name: entry.name ?? 'unknown',
    status: entry.pm2_env?.status ?? 'unknown',
    execMode: entry.pm2_env?.exec_mode ?? 'unknown',
    instances: entry.pm2_env?.instances ?? 1,
    restarts: entry.pm2_env?.restart_time ?? 0,
    pid: entry.pid ?? 0,
  }));
}

/**
 * `ufw status` — whether the firewall is on, and which ports it lets in.
 *
 * Only the `To` column matters, and only the integers in it: `ufw` prints `22/tcp`, `80,443/tcp
 * (v6)` and `OpenSSH` in that column depending on how the rule was added, so the parser reads every
 * number it finds rather than trying to model the formats.
 */
export function parseUfwStatus(text: string): { active: boolean; ports: number[] } {
  const active = /^Status:\s*active\s*$/m.test(text);
  const ports = new Set<number>();
  for (const line of text.split('\n')) {
    const target = line.split(/\s{2,}/)[0];
    if (target === undefined || /^(Status|To|--)/.test(target.trim())) continue;
    for (const match of target.matchAll(/\b(\d{1,5})\b/g)) ports.add(Number(match[1]));
  }
  return { active, ports: [...ports].sort((a, b) => a - b) };
}

/**
 * `sshd -T` — the *effective* configuration, not the file.
 *
 * Reading `/etc/ssh/sshd_config` would miss anything set in a drop-in under `sshd_config.d/`, which
 * on Ubuntu is where a cloud image usually puts the very setting this checks.
 */
export function parseSshdConfig(text: string): {
  passwordAuthentication: boolean;
  permitRootLogin: boolean;
} {
  const settings = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key) settings.set(key.toLowerCase(), rest.join(' ').toLowerCase());
  }
  return {
    passwordAuthentication: settings.get('passwordauthentication') === 'yes',
    permitRootLogin: (settings.get('permitrootlogin') ?? 'no') !== 'no',
  };
}

interface RawStanza {
  status?: { code?: number };
  backup?: { type?: string; timestamp?: { stop?: number } }[];
}

/** `pgbackrest info --output=json` — the newest full backup, and whether the WAL archive is healthy. */
export function parsePgBackRestInfo(json: string): {
  fullCount: number;
  latestFullMs: number | null;
  archiveOk: boolean;
} {
  const stanza = (JSON.parse(json) as RawStanza[])[0];
  if (stanza === undefined) return { fullCount: 0, latestFullMs: null, archiveOk: false };
  const fulls = (stanza.backup ?? []).filter((backup) => backup.type === 'full');
  const latest = fulls.at(-1);
  const stop = latest?.timestamp?.stop;
  return {
    fullCount: fulls.length,
    // pgBackRest reports seconds; every comparison here is in milliseconds.
    latestFullMs: stop === undefined ? null : stop * 1000,
    archiveOk: (stanza.status?.code ?? 1) === 0,
  };
}

/**
 * The bucket and access key pgBackRest is actually configured with.
 *
 * Read from its own configuration file rather than from `.env`, so the isolation check compares the
 * settings in force rather than a second copy of them that could disagree.
 */
export function parsePgBackRestConfig(text: string): {
  bucket: string | null;
  accessKeyId: string | null;
} {
  const read = (key: string): string | null =>
    text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  return { bucket: read('repo1-s3-bucket'), accessKeyId: read('repo1-s3-key') };
}

/** Whole days from `now` until `when`, rounded down. Negative once it is past. */
export function daysUntil(when: number, now: number): number {
  return Math.floor((when - now) / 86_400_000);
}

// =================================================================================================
// Small helpers the checks share.
// =================================================================================================

interface Result {
  readonly ok: boolean;
  readonly detail: string;
}

const ok = (detail: string): Result => ({ ok: true, detail });
const bad = (detail: string): Result => ({ ok: false, detail });

async function run(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} is not set in the environment this ran with — see .env.example.`);
  }
  return value.trim();
}

/** A `psql` one-liner against `DATABASE_URL`, unaligned and untitled, so the answer is the output. */
async function query(sql: string): Promise<string> {
  return (await run('psql', [requireEnv('DATABASE_URL'), '-At', '-c', sql])).trim();
}

function origin(): string {
  return requireEnv('NEXT_PUBLIC_API_ORIGIN').replace(/\/+$/, '');
}

function hostname(): string {
  return new URL(origin()).hostname;
}

/** Every `<script src>` the origin's HTML pulls in — the client bundle, as a browser receives it. */
async function servedClientScripts(): Promise<string> {
  const html = await (await fetch(origin(), { redirect: 'follow' })).text();
  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((source): source is string => source !== undefined && source.startsWith('/'));
  const bodies = await Promise.all(
    sources.map(async (source) => (await fetch(`${origin()}${source}`)).text()),
  );
  return bodies.join('\n');
}

interface Check {
  readonly name: string;
  /** `remote` needs nothing but HTTP to the origin; `box` reads the host and only means anything there. */
  readonly reach: 'remote' | 'box';
  readonly run: () => Promise<Result>;
}

// =================================================================================================
// The checks.
// =================================================================================================

const CHECKS: readonly Check[] = [
  {
    name: 'tls',
    reach: 'remote',
    async run() {
      const response = await fetch(origin());
      // A 502 is a pass here: between Group 1 and Group 2 that is the correct state of the box, and
      // this check is about the certificate, not about what is behind it.
      if (!response.ok && response.status !== 502) {
        return bad(`the origin answered ${response.status}`);
      }
      const enddate = execFileSync(
        'sh',
        [
          '-c',
          `echo | openssl s_client -connect ${hostname()}:443 -servername ${hostname()} 2>/dev/null | openssl x509 -noout -enddate`,
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .replace('notAfter=', '');
      const days = daysUntil(new Date(enddate).getTime(), Date.now());
      return days > 20 ? ok(`valid, ${days} days left`) : bad(`expires in ${days} days`);
    },
  },
  {
    name: 'http-redirect',
    reach: 'remote',
    async run() {
      const response = await fetch(origin().replace('https://', 'http://'), { redirect: 'manual' });
      const location = response.headers.get('location') ?? '';
      return response.status === 301 && location.startsWith(origin())
        ? ok(`301 → ${location}`)
        : bad(`answered ${response.status} → ${location || '(no location)'}`);
    },
  },
  {
    name: 'certbot-renewal',
    reach: 'box',
    async run() {
      await run('sudo', ['certbot', 'renew', '--dry-run']);
      // A certificate that has never proven it renews is a 90-day outage with a start date.
      return ok('dry run succeeded');
    },
  },
  {
    name: 'pgvector',
    reach: 'box',
    async run() {
      const available = await query(
        "select count(*) from pg_available_extensions where name = 'vector'",
      );
      const enabled = await query("select count(*) from pg_extension where extname = 'vector'");
      if (available === '0') return bad('the vector package is not installed on this instance');
      if (enabled !== '0') {
        return bad('the vector extension is ENABLED — this epic requires it available and unenabled');
      }
      return ok('installed and available, not enabled');
    },
  },
  {
    name: 'network',
    reach: 'box',
    async run() {
      const listen = await query('show listen_addresses');
      if (!/^(localhost|127\.0\.0\.1)/.test(listen)) return bad(`listen_addresses is "${listen}"`);

      // A configuration value and a reachable port are two different claims. This is the second.
      const { address } = await lookup(hostname());
      const reachable = await new Promise<boolean>((settle) => {
        const socket = createConnection({ host: address, port: 5432, timeout: 4000 });
        socket.on('connect', () => {
          socket.destroy();
          settle(true);
        });
        socket.on('error', () => settle(false));
        socket.on('timeout', () => {
          socket.destroy();
          settle(false);
        });
      });
      if (reachable) return bad(`Postgres answered on ${address}:5432 from outside`);

      const firewall = parseUfwStatus(await run('sudo', ['ufw', 'status']));
      if (!firewall.active) return bad('ufw is not active');
      const unexpected = firewall.ports.filter((port) => ![22, 80, 443].includes(port));
      return unexpected.length === 0
        ? ok(`ufw active, ${firewall.ports.join('/')} only; 5432 refused from ${address}`)
        : bad(`ufw also allows ${unexpected.join(', ')}`);
    },
  },
  {
    name: 'hardening',
    reach: 'box',
    async run() {
      const owner = statSync(REPO_ROOT).uid;
      if (owner === 0) return bad('the checkout is owned by root');
      if (owner !== userInfo().uid) {
        return bad('this is not running as the user that owns the checkout');
      }
      const sshd = parseSshdConfig(await run('sudo', ['sshd', '-T']));
      if (sshd.passwordAuthentication) return bad('SSH accepts passwords');
      if (sshd.permitRootLogin) return bad('SSH permits root login');
      return ok(`runs as ${userInfo().username}, SSH is key-only`);
    },
  },
  {
    name: 'secrets',
    reach: 'box',
    async run() {
      const stats = statSync(resolve(REPO_ROOT, '.env'));
      const mode = (stats.mode & 0o777).toString(8);
      if (mode !== '600') return bad(`.env is mode ${mode}, not 600`);
      if (stats.uid !== userInfo().uid) return bad('.env is owned by another user');
      const dirty = (await run('git', ['-C', REPO_ROOT, 'status', '--porcelain'])).trim();
      if (dirty !== '') return bad(`the checkout has uncommitted changes:\n${dirty}`);
      const ignored = await run('git', ['-C', REPO_ROOT, 'check-ignore', '.env']).catch(() => '');
      if (ignored.trim() === '') return bad('.env is not gitignored');
      // Nothing above reads a value out of the file, only its metadata.
      return ok('one .env, mode 600, gitignored; tree clean');
    },
  },
  {
    name: 'services',
    reach: 'box',
    async run() {
      const apps = parsePm2List(await run('pm2', ['jlist']));
      const web = apps.find((app) => app.name === 'thp-web');
      const workers = apps.filter((app) => app.name === 'thp-worker');
      const worker = workers[0];
      if (web === undefined || worker === undefined) {
        return bad('pm2 does not have both thp-web and thp-worker');
      }
      if (web.status !== 'online' || worker.status !== 'online') {
        return bad(`thp-web is ${web.status}, thp-worker is ${worker.status}`);
      }
      // The pin that matters. Cluster mode runs a second worker, and the boot sweep assumes there
      // is only one — a second copy reclaims jobs the first is still running.
      if (worker.execMode !== 'fork') return bad(`the worker is in ${worker.execMode} mode, not fork`);
      if (worker.instances !== 1) return bad(`the worker has ${worker.instances} instances, not 1`);
      if (workers.length !== 1) return bad(`${workers.length} worker processes are registered`);
      return ok('thp-web and thp-worker online; worker fork mode, 1 instance');
    },
  },
  {
    name: 'boot',
    reach: 'box',
    async run() {
      const unit = (
        await run('sh', [
          '-c',
          'systemctl list-units --all --type=service --no-legend | grep -i pm2 || true',
        ])
      ).trim();
      if (unit === '') return bad('no pm2 systemd unit — run `pm2 startup systemd`');
      for (const service of ['postgresql', 'nginx']) {
        const enabled = (await run('systemctl', ['is-enabled', service]).catch(() => 'no')).trim();
        if (enabled !== 'enabled') return bad(`${service} is ${enabled}, not enabled`);
      }
      // `pm2 save` records what was running, not what the config file says — so a list saved before
      // both apps were started comes back after a reboot missing one of them.
      const saved = JSON.parse(
        readFileSync(resolve(userInfo().homedir, '.pm2', 'dump.pm2'), 'utf8'),
      ) as { name?: string }[];
      const names = saved.map((entry) => entry.name);
      for (const name of ['thp-web', 'thp-worker']) {
        if (!names.includes(name)) return bad(`${name} is not in the saved pm2 list — run \`pm2 save\``);
      }
      return ok('pm2 unit installed, both apps saved, postgresql and nginx enabled');
    },
  },
  {
    name: 'migrations',
    reach: 'box',
    async run() {
      const journal = JSON.parse(
        readFileSync(resolve(REPO_ROOT, 'packages/db/drizzle/meta/_journal.json'), 'utf8'),
      ) as { entries: unknown[] };
      const applied = Number(await query('select count(*) from drizzle.__drizzle_migrations'));
      return applied === journal.entries.length
        ? ok(`${applied} of ${journal.entries.length} applied`)
        : bad(`${applied} applied, ${journal.entries.length} in the journal — run \`npm run migrate\``);
    },
  },
  {
    name: 'origin',
    reach: 'remote',
    async run() {
      const scripts = await servedClientScripts();
      if (scripts.trim() === '') return bad('the origin served no client scripts — is the app running?');
      if (!scripts.includes(origin())) return bad(`no client script carries ${origin()}`);
      if (scripts.includes('http://localhost')) return bad('a client script carries http://localhost');
      return ok(`the served bundle calls ${origin()}`);
    },
  },
  {
    name: 'diagnostics',
    reach: 'remote',
    async run() {
      if (process.env['ENABLE_DIAGNOSTIC_ROUTES'] === 'true') {
        return bad('ENABLE_DIAGNOSTIC_ROUTES is true');
      }
      const response = await fetch(`${origin()}/api/v1/diagnostics/unguarded`);
      const body = await response.text();
      return body.includes('"unguarded":true')
        ? bad('the unguarded diagnostic route answered with a payload')
        : ok(`refused with ${response.status}`);
    },
  },
  {
    name: 'not-mocked',
    reach: 'box',
    async run() {
      const value = process.env['THP_MOCK_EXTERNAL'];
      return value === undefined || ['false', '0', ''].includes(value.trim().toLowerCase())
        ? ok('unset — real providers')
        : bad(`THP_MOCK_EXTERNAL is "${value}", so this box reaches no provider`);
    },
  },
  {
    name: 'backup',
    reach: 'box',
    async run() {
      await run('sudo', ['-u', 'postgres', 'pgbackrest', '--stanza=thp', 'check']);
      const info = parsePgBackRestInfo(
        await run('sudo', ['-u', 'postgres', 'pgbackrest', '--stanza=thp', '--output=json', 'info']),
      );
      if (info.fullCount === 0 || info.latestFullMs === null) return bad('no full backup exists');
      if (!info.archiveOk) return bad('the WAL archive is not healthy');
      const hours = (Date.now() - info.latestFullMs) / 3_600_000;
      // 26 rather than 24, so a check run shortly before the 02:00 timer is not a false failure.
      return hours < 26
        ? ok(`${info.fullCount} full backups, newest ${hours.toFixed(1)}h old, archive ok`)
        : bad(`the newest full backup is ${hours.toFixed(1)}h old`);
    },
  },
  {
    name: 'backup-isolation',
    reach: 'box',
    async run() {
      const config = parsePgBackRestConfig(readFileSync('/etc/pgbackrest/pgbackrest.conf', 'utf8'));
      if (config.bucket === null) return bad('pgbackrest.conf names no S3 bucket');
      if (config.bucket === process.env['MEDIA_BUCKET']) {
        return bad(
          'backups go to the media bucket — retention would delete from the one bucket nothing may delete from',
        );
      }
      if (config.accessKeyId === process.env['MEDIA_ACCESS_KEY_ID']) {
        return bad('backups use the media bucket credentials, which carry delete');
      }
      return ok(`separate bucket "${config.bucket}" under its own key`);
    },
  },
  {
    name: 'restore-drill-age',
    reach: 'box',
    async run() {
      const receipt = statSync(resolve(REPO_ROOT, '.restore-drill'));
      const days = Math.floor((Date.now() - receipt.mtimeMs) / 86_400_000);
      // A backup verified once in 2026 is an unverified backup in 2027.
      return days <= 90
        ? ok(`last drill ${days} days ago`)
        : bad(`the last restore drill was ${days} days ago — run scripts/restore-drill.sh`);
    },
  },
];

// =================================================================================================
// The two modes that act rather than read.
// =================================================================================================

/**
 * Kill the worker and watch pm2 bring it back.
 *
 * Safe to run at any time, and that is the point: dispatch is at-least-once and the worker's boot
 * sweep reclaims whatever a dead worker left `running`, so this exercises the recovery path rather
 * than working around it.
 */
async function killDrill(): Promise<Result> {
  const before = parsePm2List(await run('pm2', ['jlist'])).find((app) => app.name === 'thp-worker');
  if (before === undefined) return bad('pm2 does not have thp-worker');
  process.kill(before.pid, 'SIGKILL');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 1000));
    const after = parsePm2List(await run('pm2', ['jlist'])).find((app) => app.name === 'thp-worker');
    if (after?.status === 'online' && after.pid !== before.pid && after.restarts > before.restarts) {
      return ok(`came back as pid ${after.pid} after ${attempt + 1}s`);
    }
  }
  return bad('the worker did not come back within 30s');
}

/**
 * The whole epic, on the box, against real providers.
 *
 * The only run that exercises a presigned PUT from the real origin through the real CORS rule, and
 * an ASR provider fetching the object itself from a bucket it can reach — the boundary that makes
 * MinIO unusable for real transcription, and therefore the one thing no local run has ever tested.
 * It spends about half a cent.
 */
async function smoke(audioPath: string | undefined): Promise<Result> {
  if (audioPath === undefined) return bad('pass --audio=<path to a short audio file>');
  const base = `${origin()}/api/v1`;
  const audio = readFileSync(audioPath);
  const contentType = audioPath.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg';

  const signIn = await fetch(`${base}/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: requireEnv('SEED_ADMIN_EMAIL'),
      password: requireEnv('SEED_ADMIN_PASSWORD'),
    }),
  });
  if (!signIn.ok) return bad(`sign-in answered ${signIn.status}`);
  const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const send = async (path: string, body: unknown): Promise<Record<string, string>> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path} answered ${response.status}`);
    return (await response.json()) as Record<string, string>;
  };

  const grant = await send('/recordings/uploads', {
    filename: basename(audioPath),
    contentType,
    size: audio.byteLength,
  });
  const put = await fetch(grant['url'] ?? '', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(audio),
  });
  if (!put.ok) return bad(`the presigned PUT answered ${put.status}`);

  const recording = await send('/recordings', {
    key: grant['key'],
    title: `Production smoke — ${basename(audioPath)}`,
    recordedAt: new Date().toISOString().slice(0, 10),
  });
  const recordingId = recording['id'];

  // Real transcription of a minute of audio, then a real generation call over it.
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${base}/pipeline`, { headers: { cookie } })).json()) as {
      recordings: { recordingId: string; steps: { step: string; status: string; error: string | null }[] }[];
    };
    const steps = list.recordings.find((row) => row.recordingId === recordingId)?.steps ?? [];
    const failure = steps.find((step) => step.status === 'failed');
    if (failure !== undefined) return bad(`${failure.step} failed: ${failure.error ?? 'no reason recorded'}`);
    if (steps.length > 0 && steps.every((step) => step.status === 'succeeded')) break;
    await new Promise((settle) => setTimeout(settle, 5000));
  }

  await send(`/recordings/${recordingId}/publish`, {});
  const playback = await fetch(`${base}/recordings/${recordingId}/playback`, { headers: { cookie } });
  if (!playback.ok) return bad(`playback answered ${playback.status} after publish`);
  return ok(`recording ${recordingId} transcribed, drafted, published, and playable at a signed URL`);
}

// =================================================================================================
// The run.
//
// Guarded, so that importing this module reads its parsers without running a single check — which
// is what tests/unit/verify-production.test.ts does, and what it must be able to do without
// touching `pm2`, `ufw` or the network.
// =================================================================================================

async function report(label: string, action: () => Promise<Result>): Promise<number> {
  let result: Result;
  try {
    result = await action();
  } catch (error) {
    result = bad(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error));
  }
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${result.detail}\n`);
  return result.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const has = (flag: string): boolean => flags.includes(flag);
  const valueOf = (flag: string): string | undefined =>
    flags.find((entry) => entry.startsWith(`${flag}=`))?.slice(flag.length + 1);

  const selected = has('--remote-only') ? CHECKS.filter((check) => check.reach === 'remote') : CHECKS;
  let failed = 0;
  let ran = 0;

  // Every check runs even after one fails, so a single run diagnoses the box rather than bisecting it.
  for (const check of selected) {
    failed += await report(check.name, () => check.run());
    ran += 1;
  }
  if (has('--kill-drill')) {
    failed += await report('kill-drill', killDrill);
    ran += 1;
  }
  if (has('--smoke')) {
    failed += await report('smoke', () => smoke(valueOf('--audio')));
    ran += 1;
  }

  process.stdout.write(failed === 0 ? `\n${ran} checks passed.\n` : `\n${failed} of ${ran} failed.\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) await main();
