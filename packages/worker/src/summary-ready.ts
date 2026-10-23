import { insertNotificationForActiveAdmins, type Executor } from '@thp/db';
import { ADMIN_REVIEWS_PAGE_PATH, SUMMARY_READY_TITLE } from '@thp/shared';
import { logger } from '@thp/shared/observability/logger';

/**
 * **A draft is waiting — tell the admins** ([3.17.10](docs/project/prd.md),
 * [3.6.3](docs/project/prd.md)).
 *
 * Raised from the worker rather than from the API because the worker is where the draft lands
 * (project tdd 5.4: job completion raises the domain event, and this is its first subscriber).
 * The web app's notifications service is unreachable from here — the import-boundary guard
 * refuses a worker that reaches into `packages/web` — so the sentence, the destination and the
 * audience are decided in this file and written through the one statement `@thp/db` offers for
 * "every active admin". The press lands on the review queue, which is where every draft is read.
 *
 * **Throws nothing to the handler.** The drafts are already written and the job is about to
 * succeed; a notice that could not be written is a line in the log, not a failed step — failing
 * the step would make an admin re-run a generation that worked, and spend on it again, to fix a
 * row in an inbox. The same rule the API's `raise` applies to a publish.
 *
 * Once per run, including a steered regeneration: each run is a fresh draft waiting on a person,
 * and the admin who asked for the regeneration is one of the people it waits on.
 */
export async function notifySummaryReady(
  input: { readonly recordingId: string; readonly title: string },
  executor?: Executor,
): Promise<void> {
  try {
    const recipients = await insertNotificationForActiveAdmins(
      {
        kind: 'summary_ready',
        title: SUMMARY_READY_TITLE,
        body: input.title,
        href: ADMIN_REVIEWS_PAGE_PATH,
        recordingId: input.recordingId,
      },
      executor,
    );
    logger.info('notification.raised', {
      event: 'summary.ready',
      recordingId: input.recordingId,
      recipients,
    });
  } catch (caught) {
    logger.error('notification.failed', {
      event: 'summary.ready',
      recordingId: input.recordingId,
      errorName: caught instanceof Error ? caught.name : typeof caught,
      errorMessage: caught instanceof Error ? caught.message : String(caught),
    });
  }
}
