import { listRecordingsMissingPlayback } from '@thp/db';
import { producePlaybackRendition } from '../process-audio';

/**
 * **Backfill the playback renditions** — `npm run backfill:playback`.
 *
 * Every recording uploaded before the `process_audio` step existed still plays from its original,
 * which is the file browsers cannot seek exactly. This walks those recordings oldest-first and
 * produces each one's rendition, **outside the job ledger on purpose**: a succeeded job enqueues
 * its successor, and a backfill that chained into `transcribe` would spend the provider on every
 * teaching and replace every transcript — and its corrections — in the library.
 *
 * Idempotent and resumable: only rows with no rendition are listed, so a run interrupted after
 * fifteen teachings picks up at the sixteenth. A failure is reported and **stops the run** — one
 * broken file is worth looking at before the same mistake is made at scale.
 */
async function main(): Promise<void> {
  const waiting = await listRecordingsMissingPlayback();
  if (waiting.length === 0) {
    console.log('Every recording already has a playback rendition. Nothing to do.');
    return;
  }

  console.log(`${waiting.length} recording(s) still play from the original. Processing...`);

  for (const [index, recording] of waiting.entries()) {
    const label = `${index + 1}/${waiting.length} "${recording.title}" (${recording.id})`;
    process.stdout.write(`  ${label} ... `);
    const result = await producePlaybackRendition(recording.id);
    const megabytes = (result.renditionBytes / (1024 * 1024)).toFixed(1);
    console.log(`done — ${result.renditionKey} (${megabytes} MB, via ${result.tool})`);
  }

  console.log('Backfill complete.');
}

main().then(
  () => process.exit(0),
  (cause: unknown) => {
    console.error(
      `Backfill stopped: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'Fix the cause and run it again — recordings already processed are not redone.',
    );
    process.exit(1);
  },
);
