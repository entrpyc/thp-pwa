import { ApiError } from './errors';

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The `/api/v1/diagnostics/*` routes exist so the error, envelope and correlation-id behaviour can
 * be tested through real HTTP rather than by importing handlers. They must never answer in a
 * deployment, where they are indistinguishable from an unknown path — the integration suite opts
 * back in with `ENABLE_DIAGNOSTIC_ROUTES`.
 */
export function assertDiagnosticsEnabled(env: EnvSource = process.env): void {
  const isProduction = env['NODE_ENV'] === 'production';
  if (isProduction && env['ENABLE_DIAGNOSTIC_ROUTES'] !== 'true') {
    throw ApiError.notFound('The requested resource does not exist.');
  }
}

/** Deliberately distinctive, so a test can assert it never reaches the client. */
export const BOOM_INTERNAL_MESSAGE =
  'internal detail that must not be exposed: connection string swordfish';
