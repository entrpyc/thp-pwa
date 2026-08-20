import { describe, expect, it } from 'vitest';
import { assertDiagnosticsEnabled } from '@/server/api/diagnostics';
import { ApiError } from '@/server/api/errors';

describe('the diagnostics routes are not a production surface', () => {
  it('is a 404, not an error, in production by default', () => {
    const env = { NODE_ENV: 'production' };

    expect(() => assertDiagnosticsEnabled(env)).toThrowError(ApiError);
    try {
      assertDiagnosticsEnabled(env);
    } catch (error) {
      // Indistinguishable from any unknown path — it does not admit the route exists.
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).code).toBe('not_found');
      expect((error as ApiError).message).not.toMatch(/diagnostic/i);
    }
  });

  it('stays a 404 when the flag is present but not the exact opt-in value', () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      expect(() =>
        assertDiagnosticsEnabled({ NODE_ENV: 'production', ENABLE_DIAGNOSTIC_ROUTES: value }),
      ).toThrowError(ApiError);
    }
  });

  it('is available in development without any flag', () => {
    expect(() => assertDiagnosticsEnabled({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('is available in production only when explicitly enabled — how the suite gets at it', () => {
    expect(() =>
      assertDiagnosticsEnabled({ NODE_ENV: 'production', ENABLE_DIAGNOSTIC_ROUTES: 'true' }),
    ).not.toThrow();
  });
});
