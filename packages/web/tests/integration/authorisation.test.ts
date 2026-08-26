import { afterAll, describe, expect, it, inject } from 'vitest';
import { API_PREFIX, CORRELATION_ID_HEADER, ROLE, isApiErrorBody } from '@thp/shared';
import { closeTestDatabase, signedInAccount } from '../support/accounts';
import { logOffset, waitForLogLines } from '../support/log-reader';

const baseUrl = inject('apiBaseUrl');
const databaseUrl = inject('databaseUrl');
const logPath = inject('apiLogPath');
const api = (path: string) => `${baseUrl}${API_PREFIX}${path}`;
const adminOnly = api('/diagnostics/admin-only');

afterAll(async () => {
  await closeTestDatabase();
});

async function codeOf(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => undefined);
  return isApiErrorBody(body) ? body.error.code : null;
}

describe('the refusal is the API’s, not the client’s', () => {
  it('permits an admin-only route for an admin', async () => {
    const { account, cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.admin, 'admin');
    const response = await fetch(adminOnly, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect((await response.json()) as { actorId: string }).toMatchObject({ actorId: account.id });
  });

  it('refuses it for a member, whatever the client would have rendered', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'member');
    const response = await fetch(adminOnly, { headers: { cookie } });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('forbidden');
  });

  it('distinguishes a refused session from no session at all', async () => {
    const { cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'distinct');

    const authenticated = await fetch(adminOnly, { headers: { cookie } });
    const anonymous = await fetch(adminOnly);
    // Read each body once — a Response body is a stream, not a value.
    const [refused, turnedAway] = await Promise.all([codeOf(authenticated), codeOf(anonymous)]);

    expect(authenticated.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(refused).toBe('forbidden');
    expect(turnedAway).toBe('unauthenticated');
    // Error types are part of the contract (project tdd 6.4), so a
    // client can tell "sign in" from "you may not" without parsing a message.
    expect(refused).not.toBe(turnedAway);
  });

  it('logs every refusal with actor, action, target and timestamp, under the request’s id', async () => {
    const { account, cookie } = await signedInAccount(baseUrl, databaseUrl, ROLE.member, 'logged');
    const offset = logOffset(logPath);
    const correlationId = 'refusal-log-test-0123456789';

    const response = await fetch(adminOnly, {
      headers: { cookie, [CORRELATION_ID_HEADER]: correlationId },
    });
    expect(response.status).toBe(403);

    const lines = await waitForLogLines(logPath, offset, (candidates) =>
      candidates.some((line) => line.message === 'authorisation.refused'),
    );
    const refusal = lines.find((line) => line.message === 'authorisation.refused');

    expect(refusal).toBeDefined();
    expect(refusal?.correlationId).toBe(correlationId);
    expect(refusal?.['actorId']).toBe(account.id);
    expect(refusal?.['action']).toBe('diagnostics.admin');
    expect(refusal?.['target']).toBe(`route:${API_PREFIX}/diagnostics/admin-only`);
    expect(typeof refusal?.time).toBe('string');
    expect(Number.isNaN(Date.parse(String(refusal?.time)))).toBe(false);

    // And the rest of that request is findable by the same id, not just this one line.
    expect(lines.filter((line) => line.correlationId === correlationId).length).toBeGreaterThan(1);
  });

  it('logs an anonymous refusal with no actor rather than inventing one', async () => {
    const offset = logOffset(logPath);
    const correlationId = 'anonymous-refusal-9876543210';

    await fetch(adminOnly, { headers: { [CORRELATION_ID_HEADER]: correlationId } });

    const lines = await waitForLogLines(logPath, offset, (candidates) =>
      candidates.some(
        (line) =>
          line.message === 'authorisation.refused' && line.correlationId === correlationId,
      ),
    );
    const refusal = lines.find((line) => line.message === 'authorisation.refused');

    expect(refusal?.['actorId']).toBeNull();
    expect(refusal?.['action']).toBe('anonymous-access');
  });
});
