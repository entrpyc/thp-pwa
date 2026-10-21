import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  parsePgBackRestConfig,
  parsePgBackRestInfo,
  parsePm2List,
  parseSshdConfig,
  lastHeartbeatAt,
  parseHealthchecksEnv,
  parseUfwStatus,
  unhealthyAlloyComponents,
  unitPingsHealthchecks,
} from '../../scripts/verify-production';

/**
 * The parsers inside `scripts/verify-production.mjs`, driven against captured output from the real
 * commands.
 *
 * The script itself cannot be tested — every check reads a machine that does not exist in CI. Its
 * parsers can, and they are where the bugs would be: a `pm2 jlist` shape misread is a check that
 * passes on a two-instance worker, which is the one thing it exists to catch. Debugging that on the
 * box, after a reboot, is the alternative this file buys out of.
 */

describe('pm2 jlist', () => {
  const CAPTURED = JSON.stringify([
    { name: 'thp-web', pid: 1201, pm2_env: { status: 'online', exec_mode: 'fork_mode', instances: 1, restart_time: 0 } },
    {
      name: 'thp-worker',
      pid: 1202,
      pm2_env: {
        status: 'online',
        exec_mode: 'fork_mode',
        instances: 1,
        restart_time: 3,
        // pm2 puts the process id in the name in fork mode; the check reads this rather than guessing it.
        pm_out_log_path: '/home/thp/.pm2/logs/thp-worker-out-1.log',
      },
    },
  ]);

  it('reads the fields the supervision criterion turns on', () => {
    const [web, worker] = parsePm2List(CAPTURED);

    expect(web).toMatchObject({ name: 'thp-web', status: 'online', pid: 1201, outLogPath: null });
    expect(worker).toMatchObject({
      execMode: 'fork_mode',
      instances: 1,
      restarts: 3,
      pid: 1202,
      outLogPath: '/home/thp/.pm2/logs/thp-worker-out-1.log',
    });
  });

  it('surfaces cluster mode rather than smoothing it over', () => {
    // The check refuses cluster mode because the worker's boot sweep assumes a single process; a
    // parser that defaulted this field would hide exactly that.
    const clustered = JSON.stringify([
      { name: 'thp-worker', pid: 9, pm2_env: { status: 'online', exec_mode: 'cluster_mode', instances: 4 } },
    ]);
    expect(parsePm2List(clustered)[0]).toMatchObject({ execMode: 'cluster_mode', instances: 4 });
  });

  it('does not invent a status for a stopped process', () => {
    const stopped = JSON.stringify([{ name: 'thp-worker', pm2_env: { status: 'stopped' } }]);
    expect(parsePm2List(stopped)[0]).toMatchObject({ status: 'stopped', pid: 0 });
  });
});

describe('ufw status', () => {
  const CAPTURED = `Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80,443/tcp                 ALLOW       Anywhere
22/tcp (v6)                ALLOW       Anywhere (v6)
`;

  it('reads every port however the rule was written', () => {
    // ufw prints `22/tcp`, `80,443/tcp` and `OpenSSH` in the same column depending on how the rule
    // was added, so the parser reads integers rather than modelling the formats.
    expect(parseUfwStatus(CAPTURED)).toEqual({ active: true, ports: [22, 80, 443] });
  });

  it('reports an inactive firewall as inactive', () => {
    expect(parseUfwStatus('Status: inactive\n').active).toBe(false);
  });

  it('sees a port that should not be open', () => {
    const leaky = `${CAPTURED}5432/tcp                   ALLOW       Anywhere\n`;
    expect(parseUfwStatus(leaky).ports).toContain(5432);
  });
});

describe('sshd -T', () => {
  it('reads the effective configuration, not the file', () => {
    const captured = 'port 22\npasswordauthentication no\npermitrootlogin prohibit-password\n';
    expect(parseSshdConfig(captured)).toEqual({ passwordAuthentication: false, permitRootLogin: true });
  });

  it('treats a hardened box as hardened', () => {
    const captured = 'passwordauthentication no\npermitrootlogin no\n';
    expect(parseSshdConfig(captured)).toEqual({ passwordAuthentication: false, permitRootLogin: false });
  });

  it('treats a missing PermitRootLogin as no, which is the sshd default on Ubuntu images we harden', () => {
    expect(parseSshdConfig('passwordauthentication yes\n')).toEqual({
      passwordAuthentication: true,
      permitRootLogin: false,
    });
  });
});

describe('pgbackrest info', () => {
  const CAPTURED = JSON.stringify([
    {
      name: 'thp',
      status: { code: 0 },
      backup: [
        { type: 'full', timestamp: { stop: 1_770_000_000 } },
        { type: 'full', timestamp: { stop: 1_770_086_400 } },
      ],
    },
  ]);

  it('reads the newest full backup and the archive verdict', () => {
    expect(parsePgBackRestInfo(CAPTURED)).toEqual({
      fullCount: 2,
      latestFullMs: 1_770_086_400_000,
      archiveOk: true,
    });
  });

  it('reports a stanza with nothing in it rather than throwing', () => {
    const empty = JSON.stringify([{ name: 'thp', status: { code: 1 }, backup: [] }]);
    expect(parsePgBackRestInfo(empty)).toEqual({ fullCount: 0, latestFullMs: null, archiveOk: false });
  });

  it('reports an unhealthy archive even when backups exist', () => {
    const broken = JSON.stringify([{ status: { code: 3 }, backup: [{ type: 'full', timestamp: { stop: 1 } }] }]);
    expect(parsePgBackRestInfo(broken).archiveOk).toBe(false);
  });
});

describe('pgbackrest.conf', () => {
  it('reads the bucket and key actually in force', () => {
    // Read from pgBackRest's own file rather than from .env, so the isolation check compares the
    // settings in force rather than a second copy that could disagree with them.
    const captured = `[global]\nrepo1-type=s3\nrepo1-s3-bucket = thp-backups\nrepo1-s3-key=AKIAEXAMPLE\nrepo1-retention-full=2\n`;
    expect(parsePgBackRestConfig(captured)).toEqual({ bucket: 'thp-backups', accessKeyId: 'AKIAEXAMPLE' });
  });

  it('answers null rather than guessing when the file names no bucket', () => {
    expect(parsePgBackRestConfig('[global]\nrepo1-type=posix\n')).toEqual({ bucket: null, accessKeyId: null });
  });
});

describe('certificate expiry', () => {
  const NOW = Date.UTC(2026, 7, 22);

  it('counts whole days remaining', () => {
    expect(daysUntil(Date.UTC(2026, 10, 12), NOW)).toBe(82);
  });

  it('goes negative once it is past, rather than wrapping to a pass', () => {
    expect(daysUntil(Date.UTC(2026, 7, 20), NOW)).toBe(-2);
  });
});

describe('the worker heartbeat, read from its log', () => {
  // One JSON line per event, as the logger writes them and pm2 files them.
  const line = (time: string, message: string) => JSON.stringify({ time, level: 'info', message });

  it('finds the newest heartbeat, reading backwards past later lines that are not one', () => {
    const log = [
      line('2026-10-21T12:00:00.000Z', 'worker.heartbeat.sent'),
      line('2026-10-21T12:05:00.000Z', 'worker.heartbeat.sent'),
      line('2026-10-21T12:06:00.000Z', 'job.claimed'),
      'Error: something a stack trace printed',
      '',
    ].join('\n');
    expect(lastHeartbeatAt(log)).toBe(Date.parse('2026-10-21T12:05:00.000Z'));
  });

  it('answers null for a log with no heartbeat in it, or one that only mentions the word', () => {
    expect(lastHeartbeatAt('')).toBeNull();
    expect(lastHeartbeatAt(line('2026-10-21T12:00:00.000Z', 'worker.started'))).toBeNull();
    expect(lastHeartbeatAt(JSON.stringify({ time: '2026-10-21T12:00:00.000Z', message: 'worker.heartbeat.failed' }))).toBeNull();
    expect(lastHeartbeatAt('worker.heartbeat.sent but not json')).toBeNull();
  });
});

describe('alloy components', () => {
  // The shape of GET /api/v0/web/components on Alloy 1.x: one entry per component, each with the
  // health its own evaluation last reported.
  const CAPTURED = JSON.stringify([
    { localID: 'prometheus.exporter.unix.host', health: { state: 'healthy', message: '' } },
    { localID: 'prometheus.exporter.postgres.db', health: { state: 'unhealthy', message: 'pq: password authentication failed' } },
    { localID: 'prometheus.remote_write.grafana_cloud', health: { state: 'healthy' } },
  ]);

  it('names the component that cannot do its job, with why', () => {
    expect(unhealthyAlloyComponents(CAPTURED)).toEqual([
      { id: 'prometheus.exporter.postgres.db', message: 'unhealthy: pq: password authentication failed' },
    ]);
  });

  it('answers an empty list for a body that is not the component list, rather than failing the check on a shape', () => {
    expect(unhealthyAlloyComponents('not json')).toEqual([]);
    expect(unhealthyAlloyComponents('{"status":"ok"}')).toEqual([]);
  });
});

describe('healthchecks wiring', () => {
  it('lists only the ping variables that carry a real URL', () => {
    const env = [
      '# comment',
      'HEALTHCHECK_BACKUP_URL=https://hc-ping.com/abc',
      'HEALTHCHECK_BACKUP_CHECK_URL=',
      'HEALTHCHECK_RESTORE_DRILL_URL=https://hc-ping.com/def',
      'OTHER=https://example.com',
    ].join('\n');
    expect(parseHealthchecksEnv(env)).toEqual(['HEALTHCHECK_BACKUP_URL', 'HEALTHCHECK_RESTORE_DRILL_URL']);
  });

  it('sees the ping line in an installed unit, and its absence in the one from before', () => {
    const wired = [
      '[Service]',
      'ExecStart=/usr/bin/pgbackrest --stanza=thp check',
      'ExecStartPost=-/usr/bin/curl -fsS -m 10 --retry 3 -o /dev/null ${HEALTHCHECK_BACKUP_CHECK_URL}',
    ].join('\n');
    expect(unitPingsHealthchecks(wired, 'HEALTHCHECK_BACKUP_CHECK_URL')).toBe(true);
    // The right line for the wrong job is still unwired for this one.
    expect(unitPingsHealthchecks(wired, 'HEALTHCHECK_BACKUP_URL')).toBe(false);
    expect(unitPingsHealthchecks('[Service]\nExecStart=/usr/bin/pgbackrest --stanza=thp check\n', 'HEALTHCHECK_BACKUP_CHECK_URL')).toBe(false);
  });
});
