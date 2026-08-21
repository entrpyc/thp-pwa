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

/**
 * The header that makes `/api/v1/diagnostics/unguarded` actually leak.
 *
 * That route is the negative control for the route sweep: a route file written *without* going
 * through `apiRoute`, which is the one thing the type system cannot catch, because a route that
 * never calls the wrapper never has to state its access. The sweep is what catches it — and a
 * guard nobody has seen fail is not a guard, so the suite has to be able to make it fail.
 *
 * It leaks only when the request carries this header *and* the diagnostics routes are enabled,
 * which is why the sweep passes against the running server and still has something to catch when
 * it re-runs with the header attached. In a deployment `ENABLE_DIAGNOSTIC_ROUTES` is unset and the
 * route refuses like any other.
 */
export const UNGUARDED_FIXTURE_HEADER = 'x-unguarded-fixture';
export const UNGUARDED_FIXTURE_VALUE = 'leak';
