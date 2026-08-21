import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The correlation store, shared by both processes (Story 2 Ticket 02).
 *
 * It lived in `packages/web` while the API was the only thing that logged. The worker is a second
 * process against the same database, and "which request caused this" has to mean the same thing in
 * both — so the store and the logger that reads it moved here, and the API's modules re-export
 * them with their call sites unchanged.
 *
 * **Deliberately not re-exported from the package index.** Reaching it means naming the subpath,
 * so no client module can pull `node:async_hooks` in by importing `@thp/shared` — and the
 * client-boundary guard fails a client that names a `node:` builtin anyway.
 *
 * The worker has no request behind it, so nothing binds this store at its top level. What binds it
 * there is a **job**: the id travels on the row across the process boundary, and the runner enters
 * it before the handler runs.
 */

export interface RequestContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Ids we are willing to adopt from a caller. Bounded and restricted so a header cannot smuggle a
 * newline into the log stream or an unbounded string into every log line.
 */
const ACCEPTABLE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Adopt the caller's id when it is usable, otherwise mint one. Adoption is what lets a single id
 * span API request -> job -> provider call once the worker exists.
 */
export function resolveCorrelationId(incoming: string | null | undefined): string {
  const candidate = incoming?.trim();
  if (candidate && ACCEPTABLE_ID.test(candidate)) return candidate;
  return randomUUID();
}

/** Run `fn` with `correlationId` bound to this async execution and everything it awaits. */
export function withCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The id of the request currently being handled, or `undefined` outside a request. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
