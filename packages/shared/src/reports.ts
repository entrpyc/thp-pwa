import { notePath } from './notes';
import { sosPath, type SosUrgency } from './sos';

/**
 * **A report on member-written content, said once for the whole repository** — the member-facing
 * half of what Apple guideline 1.2 and Google Play's user-generated-content policy ask of a product
 * with member-written content: a way to flag something, and an operator who acts on it.
 *
 * Two kinds of content can be flagged, and the queue lists both: a public note (or a reply, which
 * is a note with a parent), and a prayer request or a reply on one ([3.16](docs/project/prd.md)).
 * Each kind has its own route to report through, because each is addressed by its own id; the
 * reasons, the outcomes, the detail ceiling and the console are the same for both.
 *
 * Three things live here because the menu, the API, the console and the database each have to
 * agree about them:
 *
 * 1. **The reasons.** A short, fixed list, derived into the database's `report_reason` enum
 *    rather than restated beside it (tools/domain-declarations.ts registers it), and rendered by
 *    the dialog from the labels below so the admin reads the same word the member chose.
 * 2. **The outcomes.** An admin dismisses a report or removes the note; nothing else is an
 *    outcome. Derived into `report_outcome` the same way.
 * 3. **The wire contract** — the paths and the shapes, so the dialog and the console parse exactly
 *    what the routes promise.
 *
 * **What is deliberately absent.** A report does not hide the note from the reporter — the
 * confirmation offers *Block* for that, which already exists and already works symmetrically.
 * A report cannot be withdrawn: it is a request for a person to look, and the look is cheap. And a
 * private note cannot be reported, because nobody but its author can see it to report it.
 */

// =================================================================================================
// The vocabulary
// =================================================================================================

/**
 * Why a member is reporting. Five rather than a free list: the member is choosing which rule of
 * `/terms` the note breaks, and the posting rules are five-and-a-bit sentences. `other` exists so
 * a member is never forced to mislabel something, and it is the one reason the dialog nudges
 * towards adding a sentence of detail.
 */
export const REPORT_REASONS = ['harassment', 'hateful', 'sexual', 'spam', 'other'] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * How each reason reads wherever a person sees it — the dialog's radio and the console's row. A
 * record rather than a `switch`, so adding a reason is a compile error in one place.
 */
export const REPORT_REASON_LABEL: Readonly<Record<ReportReason, string>> = {
  harassment: 'Harassment or threats',
  hateful: 'Hateful or contemptuous',
  sexual: 'Sexual or violent',
  spam: 'Spam or advertising',
  other: 'Something else',
};

/**
 * What an admin did with a report. `removed` means the note was deleted through the ordinary
 * moderation path and its audit line was written; `dismissed` means an admin read it and left the
 * note up. Both close the report.
 */
export const REPORT_OUTCOMES = ['dismissed', 'removed'] as const;

export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

export function isReportOutcome(value: unknown): value is ReportOutcome {
  return typeof value === 'string' && (REPORT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * The most a member may add to a report. A sentence or two for the admin, not a second note: the
 * note itself travels with the report, so the detail only has to say what the reason does not.
 */
export const MAX_REPORT_DETAIL_LENGTH = 500;

// =================================================================================================
// The wire contract
// =================================================================================================

/** `POST` — report this note. One route for a note and a reply, as every single-note route is. */
export function noteReportPath(noteId: string): string {
  return `${notePath(noteId)}/report`;
}

/** The console's list of open reports, relative to the `/api/v1` prefix. `GET` lists them. */
export const REPORTS_PATH = '/reports';

/** `POST` — close every open report on the content this report is about, with one outcome. */
export function reportResolvePath(reportId: string): string {
  return `${REPORTS_PATH}/${reportId}/resolve`;
}

/** The console's panel, on the web origin rather than under the API prefix. */
export const ADMIN_REPORTS_PAGE_PATH = '/admin/reports';

/**
 * `POST` — report a prayer request, or one reply on it when the body names `replyId`. One route
 * for both because a reply is read on the signal's page and addressed through it, as every reply
 * route under `/sos` is.
 */
export function sosReportPath(signalId: string): string {
  return `${sosPath(signalId)}/report`;
}

/** Body of `POST /api/v1/notes/{id}/report`. */
export interface ReportNoteRequest {
  readonly reason: ReportReason;
  /** Optional, trimmed, at most {@link MAX_REPORT_DETAIL_LENGTH} characters. */
  readonly detail?: string | null;
}

/** Body of `POST /api/v1/sos/{id}/report`: the same, plus which reply, or none for the request itself. */
export interface ReportSosRequest extends ReportNoteRequest {
  readonly replyId?: string | null;
}

/**
 * Payload of `POST /api/v1/notes/{id}/report` and of `POST /api/v1/sos/{id}/report`. Only the id:
 * the member has nothing to render from a report beyond the fact that it was taken, and the screen
 * says so in its own words.
 */
export interface ReportPayload {
  readonly reportId: string;
}

export type ReportNotePayload = ReportPayload;

/** What every open report carries, whatever it is about. */
interface ReportViewBase {
  readonly id: string;
  readonly reason: ReportReason;
  readonly detail: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly reporterDisplayName: string;
}

/**
 * One open report on a note as the console lists it: the note as it reads now, who wrote it, who
 * reported it and why, and where the note is.
 *
 * `noteText` is the text **at the moment of listing**, not at the moment of reporting — the
 * author may have edited since, and what an admin is deciding about is what members can read now.
 * An empty string means the note has already been removed (by its author, or by an earlier
 * resolution of another report), in which case the only sensible action left is dismiss.
 */
export interface NoteReportView extends ReportViewBase {
  readonly kind: 'note';
  readonly noteId: string;
  readonly noteText: string;
  /** Whether the note is a tombstone already. */
  readonly noteDeleted: boolean;
  readonly noteAuthorDisplayName: string;
  readonly recordingId: string;
  readonly recordingTitle: string;
}

/**
 * One open report on a prayer request ([3.16](docs/project/prd.md)) as the console lists it —
 * on the request itself (`kind: 'sos_signal'`, `replyId` null) or on one reply (`kind:
 * 'sos_reply'`). `text` is the request's description or the reply's words **as they read now**;
 * `deleted` says the reply has already gone (a reply is a hard delete, so there is no tombstone
 * to quote), in which case the only action left is dismiss. A request that has gone takes its
 * reports with it, so a request report is never listed as deleted.
 *
 * `authorDisplayName` is the stand-in name on a request raised anonymously
 * ([3.16.13](docs/project/prd.md)): the console is an admin's screen, but the promise the product
 * made is to everybody but the author, and moderation needs the text, not the name.
 */
export interface SosReportView extends ReportViewBase {
  readonly kind: 'sos_signal' | 'sos_reply';
  readonly signalId: string;
  readonly replyId: string | null;
  readonly urgency: SosUrgency;
  readonly text: string;
  readonly deleted: boolean;
  readonly authorDisplayName: string;
}

/** One open report, whichever kind of content it is about. `kind` says which. */
export type ReportView = NoteReportView | SosReportView;

/** Payload of `GET /api/v1/reports` — every open report, oldest first, so the queue is a queue. */
export interface ReportListPayload {
  readonly reports: readonly ReportView[];
}

/** Body of `POST /api/v1/reports/{id}/resolve`. */
export interface ResolveReportRequest {
  readonly outcome: ReportOutcome;
}

/** Payload of the same: the list as it now stands, so the console renders what came back. */
export interface ResolveReportPayload {
  readonly outcome: ReportOutcome;
  /** How many open reports on that content were closed together — at least one. */
  readonly closed: number;
  readonly reports: readonly ReportView[];
}

/** What a member reads once a report is taken. */
export const REPORT_TAKEN_MESSAGE = 'Thank you. An admin will review this note.';

/** The same, on a prayer request or a reply on one. */
export const SOS_REPORT_TAKEN_MESSAGE = 'Thank you. An admin will review it.';
