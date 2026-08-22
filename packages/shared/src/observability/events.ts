import type { ReviewKind } from '../reviews';
import { logger } from './logger';

/**
 * **Domain events — emitted, logged, and subscribed to by nothing.**
 *
 * docs/epics/epic-core-listening/architecture.md § Extension points names *Domain events at job
 * completion and at publish* as the seam [§3.17](docs/project/prd.md) attaches to: notifications
 * fan out `Notification` rows per recipient from these exact events. §3.17 is deferred whole, so
 * this epic emits them and stops there — **there is no consumer, no notification row and no
 * dispatcher**, and adding one now would be deferral quietly stopping being deferral.
 *
 * What it buys today is not nothing. An event is a line an operator can search for that says *the
 * thing happened*, distinct from the request or job line that says *the work finished* — and the
 * fact that a subscriber has somewhere to attach is only true once something is being emitted.
 *
 * **One function, one sink.** The union below is exhaustive and the emit is a single call, so the
 * day a consumer exists it is one edit here rather than a search for every place something
 * interesting happens. The sink is the logger because no other sink exists to write to.
 */

/** A draft pair — or a single re-generated kind — is waiting on an admin. */
export interface DraftGeneratedEvent {
  readonly type: 'draft_generated';
  readonly recordingId: string;
  readonly kinds: readonly ReviewKind[];
}

/** A teaching became visible to members. The one event that changes what anybody can see. */
export interface RecordingPublishedEvent {
  readonly type: 'recording_published';
  readonly recordingId: string;
}

export type DomainEvent = DraftGeneratedEvent | RecordingPublishedEvent;

/** The message every domain event is logged under, so one search returns all of them. */
export const DOMAIN_EVENT_MESSAGE = 'domain.event';

/**
 * Emit one. Returns nothing, throws nothing, and blocks on nothing — an event that could fail
 * would be a second thing the caller has to handle, and there is no consumer for it to fail
 * towards.
 */
export function emitDomainEvent(event: DomainEvent): void {
  logger.info(DOMAIN_EVENT_MESSAGE, { ...event, event: event.type });
}
