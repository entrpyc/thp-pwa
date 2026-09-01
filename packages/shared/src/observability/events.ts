import type { ReviewKind } from '../reviews';
import { logger } from './logger';

/**
 * **Domain events — emitted, logged, and subscribed to by nothing.**
 *
 * core-listening scope tdd § Extension points names *Domain events at job
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

/**
 * A teaching's chapters were replaced ([3.22.1](docs/project/prd.md)).
 *
 * **Unlike a draft, this one can change what a member is already reading.** Chapters carry no gate
 * of their own ([3.22.6](docs/project/prd.md)), so a run against a published recording replaces
 * what members are seeing the moment it commits — which is precisely why the console confirms it
 * first ([3.22.8](docs/project/prd.md)) and why the event exists to be found afterwards.
 *
 * It carries the count rather than the list: a subscriber that wants the chapters reads them, and an
 * event carrying an artefact is an event that goes stale between being emitted and being read.
 */
export interface ChaptersGeneratedEvent {
  readonly type: 'chapters_generated';
  readonly recordingId: string;
}

export type DomainEvent =
  | DraftGeneratedEvent
  | RecordingPublishedEvent
  | ChaptersGeneratedEvent;

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
