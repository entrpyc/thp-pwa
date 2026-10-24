/**
 * **What an exception report may carry** — the one shape for the API, the worker and the client
 * (docs/project/observability.md § 5.6).
 *
 * An exception is not an analytics event about a member; it is a fact about the software, keyed
 * by the correlation id already in the pm2 logs so that an issue in the tool and the lines on the
 * box are one search apart. It therefore lives outside the event vocabulary in `./analytics.ts`
 * and under the same privacy rule as everything else that leaves (§ 5.5): the context around an
 * error is opaque ids, enums and counts, **never a request body, a note's text or a raw URL**.
 * The error itself travels as its name, its message and its stack — what a log line already
 * carries — and the message is bounded so that a provider's response echoed into one cannot
 * carry a page.
 *
 * Pure, and it names no SDK: the three adapters that do are the only files allowed to
 * (`tests/guards/analytics-boundary.test.ts`), and each of them builds its report through
 * {@link exceptionProperties} before the SDK sees it.
 */

/** Where the exception was caught. One of three, and each adapter knows which one it is. */
export const EXCEPTION_PROCESSES = ['api', 'worker', 'client'] as const;
export type ExceptionProcess = (typeof EXCEPTION_PROCESSES)[number];

/**
 * The context an exception may be reported with. Every field is an id, an enum, a count or a
 * route *pattern*; `tests/guards/analytics-vocabulary.test.ts` refuses a content word here too.
 */
export interface ExceptionContext {
  readonly process: ExceptionProcess;
  /** The request's or the job's correlation id — the key that joins the report to the logs. */
  readonly correlation_id?: string | null;
  /** The HTTP method, for an API failure. */
  readonly method?: string;
  /** The route *pattern* ({@link apiRoutePattern}), never the path as requested. */
  readonly route?: string;
  readonly status?: number;
  /** The failed job, for a worker failure. */
  readonly job_id?: string;
  readonly step?: string;
  readonly attempt?: number;
  readonly recording_id?: string | null;
}

/** The property names the context above may produce, which is also what the guard test walks. */
export const EXCEPTION_PROPERTY_NAMES = [
  'process',
  'correlation_id',
  'method',
  'route',
  'status',
  'job_id',
  'step',
  'attempt',
  'recording_id',
] as const;

/** The most of a message that travels. A log line keeps the whole thing; the report is for grouping. */
export const EXCEPTION_MESSAGE_LIMIT = 500;

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
/** Anything long enough to be a token or a slug rather than a word in a route. */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The route pattern of an API path: `/api/v1/recordings/<uuid>/notes` becomes
 * `/api/v1/recordings/[id]/notes`. The privacy rule allows a route pattern and forbids a raw URL
 * (§ 5.5), and the API's handlers are not routed through the client's pattern reader, so the ids
 * are recognised by shape — a UUID, a number, or an opaque token — rather than by name. A query
 * string never arrives here at all: the caller hands in the pathname.
 */
export function apiRoutePattern(pathname: string): string {
  const segments = pathname.split('/').map((segment) => {
    if (segment === '') return segment;
    if (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment)) {
      return '[id]';
    }
    return segment;
  });
  const joined = segments.join('/');
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/**
 * The properties an adapter attaches to the report: the context's fields, by their own names,
 * with nothing undefined and nothing the context type does not declare. A caller cannot widen
 * this by passing more — the loop is over the allowed names, not over the argument.
 */
export function exceptionProperties(context: ExceptionContext): Record<string, string | number | null> {
  const properties: Record<string, string | number | null> = {};
  for (const name of EXCEPTION_PROPERTY_NAMES) {
    const value = context[name];
    if (value === undefined) continue;
    properties[name] = value;
  }
  return properties;
}

/**
 * The error as the report carries it. A thrown non-error (a string, an object) becomes an `Error`
 * named for what it was, so the tool has a type and a stack to group on; a real error keeps its
 * class, its stack and its cause chain, with the message bounded.
 */
export function normaliseException(cause: unknown): Error {
  if (cause instanceof Error) {
    if (cause.message.length <= EXCEPTION_MESSAGE_LIMIT) return cause;
    const bounded = new Error(`${cause.message.slice(0, EXCEPTION_MESSAGE_LIMIT)}…`, { cause: cause.cause });
    bounded.name = cause.name;
    if (cause.stack !== undefined) bounded.stack = cause.stack.replace(cause.message, bounded.message);
    return bounded;
  }
  const thrown = new Error(String(cause).slice(0, EXCEPTION_MESSAGE_LIMIT));
  thrown.name = `NonError(${typeof cause})`;
  return thrown;
}
