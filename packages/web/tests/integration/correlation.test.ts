import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, CORRELATION_ID_HEADER, ROLE } from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const api = (path: string) => `${baseUrl}${API_PREFIX}${path}`;

/**
 * From ticket 2 the diagnostics routes require a session, so this suite signs in first and sends the
 * cookie with every request that is not the (allowlisted) health check.
 */
let cookie = '';
const withSession = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

beforeAll(async () => {
  ({ cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'correlation'));
}, 60_000);

afterAll(async () => {
  await closeTestDatabase();
});

describe('the correlation id', () => {
  it('is present and non-empty on a success and on an error', async () => {
    const ok = await fetch(api('/health'));
    const failed = await fetch(api('/diagnostics/boom'), withSession());

    for (const response of [ok, failed]) {
      const id = response.headers.get(CORRELATION_ID_HEADER);
      expect(id).toBeTruthy();
      expect((id ?? '').length).toBeGreaterThan(7);
    }
    expect(ok.headers.get(CORRELATION_ID_HEADER)).not.toBe(
      failed.headers.get(CORRELATION_ID_HEADER),
    );
  });

  it('adopts a caller-supplied id rather than replacing it', async () => {
    const supplied = 'caller-supplied-0123456789';
    const response = await fetch(api('/health'), {
      headers: { [CORRELATION_ID_HEADER]: supplied },
    });
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(supplied);
  });

  it('adopts the same id on a failing route too', async () => {
    const supplied = 'caller-supplied-failure-42';
    const response = await fetch(api('/diagnostics/boom'), withSession({ headers: { [CORRELATION_ID_HEADER]: supplied } }));
    const body = (await response.json()) as { error: { correlationId: string } };
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(supplied);
    expect(body.error.correlationId).toBe(supplied);
  });

  it('mints a fresh id when the supplied one is unusable', async () => {
    const response = await fetch(api('/health'), {
      headers: { [CORRELATION_ID_HEADER]: 'short' },
    });
    const id = response.headers.get(CORRELATION_ID_HEADER);
    expect(id).toBeTruthy();
    expect(id).not.toBe('short');
  });

  it('gives two concurrent requests distinct ids', async () => {
    const [first, second] = await Promise.all([
      fetch(api('/diagnostics/echo?lines=3&delayMs=40&marker=concurrent-a'), withSession()),
      fetch(api('/diagnostics/echo?lines=3&delayMs=40&marker=concurrent-b'), withSession()),
    ]);
    const idA = first.headers.get(CORRELATION_ID_HEADER);
    const idB = second.headers.get(CORRELATION_ID_HEADER);
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('never lets one request log under another request id', async () => {
    const offset = logOffset(logPath);
    const idA = 'partition-test-aaaaaaaa';
    const idB = 'partition-test-bbbbbbbb';

    await Promise.all([
      fetch(api('/diagnostics/echo?lines=4&delayMs=60&marker=partition-a'), withSession({ headers: { [CORRELATION_ID_HEADER]: idA } })),
      fetch(api('/diagnostics/echo?lines=4&delayMs=60&marker=partition-b'), withSession({ headers: { [CORRELATION_ID_HEADER]: idB } })),
    ]);

    const lines = await waitForLogLines(
      logPath,
      offset,
      (candidates) =>
        candidates.filter((line) => line['marker'] === 'partition-a').length >= 4 &&
        candidates.filter((line) => line['marker'] === 'partition-b').length >= 4,
    );

    const markedA = lines.filter((line) => line['marker'] === 'partition-a');
    const markedB = lines.filter((line) => line['marker'] === 'partition-b');
    expect(markedA.length).toBeGreaterThanOrEqual(4);
    expect(markedB.length).toBeGreaterThanOrEqual(4);
    expect(new Set(markedA.map((line) => line.correlationId))).toEqual(new Set([idA]));
    expect(new Set(markedB.map((line) => line.correlationId))).toEqual(new Set([idB]));

    // The two requests really did overlap — otherwise the partition proves nothing.
    const order = lines
      .filter((line) => line['marker'] === 'partition-a' || line['marker'] === 'partition-b')
      .map((line) => line['marker']);
    const switches = order.filter((marker, index) => index > 0 && marker !== order[index - 1]).length;
    expect(switches).toBeGreaterThan(1);
  });

  it('stamps the id on every log line emitted while handling a request', async () => {
    const offset = logOffset(logPath);
    const supplied = 'every-line-carries-this-id';

    const response = await fetch(api('/diagnostics/echo?lines=5&marker=every-line'), withSession({ headers: { [CORRELATION_ID_HEADER]: supplied } }));
    expect(response.status).toBe(200);

    const lines = await waitForLogLines(logPath, offset, (candidates) =>
      candidates.some((line) => line.message === 'request.end'),
    );

    expect(lines.length).toBeGreaterThanOrEqual(7); // start + 5 echoes + end
    expect(lines.filter((line) => line.correlationId === undefined)).toEqual([]);
    expect(new Set(lines.map((line) => line.correlationId))).toEqual(new Set([supplied]));
    expect(lines.map((line) => line.message)).toContain('request.start');
    expect(lines.map((line) => line.message)).toContain('request.end');
  });

  it('finds every line for one request with a single search on the id', async () => {
    const offset = logOffset(logPath);
    const supplied = 'single-search-id-987654321';
    await fetch(api('/diagnostics/echo?lines=3&marker=single-search'), withSession({ headers: { [CORRELATION_ID_HEADER]: supplied } }));
    await fetch(api('/health'));

    const lines = await waitForLogLines(logPath, offset, (candidates) =>
      candidates.filter((line) => line.correlationId === supplied).length >= 5,
    );

    const mine = lines.filter((line) => line.correlationId === supplied);
    expect(mine.every((line) => line['marker'] === undefined || line['marker'] === 'single-search')).toBe(
      true,
    );
    expect(lines.some((line) => line.correlationId !== supplied)).toBe(true);
  });
});
