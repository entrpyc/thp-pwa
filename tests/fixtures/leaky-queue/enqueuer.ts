/**
 * The negative control for tools/queue-boundary.ts. A second door to the ledger: a module that is
 * not the queue adapter and calls the ledger's queries anyway.
 */
import { enqueueJob } from '@thp/db';

export async function leaked(): Promise<void> {
  await enqueueJob({
    recordingId: '00000000-0000-4000-8000-000000000000',
    step: 'transcribe',
    correlationId: 'not-a-request',
  });
}
