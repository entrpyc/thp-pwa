import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

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
