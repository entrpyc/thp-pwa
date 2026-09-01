import { CHAPTER_SCOPE_PARAM } from '@thp/shared';
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

/**
 * **Which chapter a read is scoped to**, or `null` when it is not scoped
 * ([3.22.14](docs/project/prd.md); project tdd 5.9).
 *
 * Beside `routeParam` because it is the same kind of thing — one value read off a request without
 * the handler reaching into a shape itself — and it is read by three routes rather than one, so a
 * fourth surface scoping a read cannot spell the parameter differently.
 *
 * A blank value reads as **not scoped** rather than as a chapter that does not exist: `?chapter=`
 * is what a client building a URL from an empty variable produces, and refusing it would turn a
 * caller's bug into an error a member sees on a page that could have been answered.
 */
export function chapterScopeParam(request: Request): string | null {
  const value = new URL(request.url).searchParams.get(CHAPTER_SCOPE_PARAM);
  return value === null || value.trim() === '' ? null : value;
}
