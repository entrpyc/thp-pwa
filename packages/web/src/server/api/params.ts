import { ApiError } from './errors';

/**
 * Read one dynamic segment off a route's params.
 *
 * Next hands params through as `string | string[] | undefined`, and a handler that reaches into
 * that shape itself is a handler that will one day pass an array where an id was expected. This
 * refuses instead — `invalid_input`, not a crash, and not a database query against `[object
 * Object]`.
 */
export async function routeParam(
  params: Promise<Record<string, string | string[] | undefined>>,
  name: string,
): Promise<string> {
  const value = (await params)[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidInput(`This route needs a ${name} in its path.`);
  }
  return value;
}
