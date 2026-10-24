import {
  deleteEmbeddingsOfKindForRecording,
  findSegmentById,
  listCrossReferencesComputedFor,
  listEmbeddingsForRecording,
  listVisibleRecordings,
  withTransaction,
  type CrossReferenceRow,
} from '@thp/db';
import { crossReferenceRecordingNow } from '../cross-reference-recording';
import { embedRecordingNow } from '../embed-recording';

/**
 * **Rebuild the embedding index as passage windows** — `npm run backfill:passages`.
 *
 * Every recording embedded before windows existed has one `segment` row per sentence. The embed
 * step reconciles by `source_id`, and a sentence row's id is not a window's id, so left to itself
 * the step would keep every sentence row it did not recognise beside the windows it wrote. This
 * walks every recording, oldest first, and for each one **in one transaction**: deletes its
 * `segment`-kind rows, runs the embed step (which writes the windows, the recording's own row and
 * everything else the step owns), then runs the cross-reference step over the new windows. One
 * recording per transaction so a search for a teaching never sees it half-populated — the old
 * rows or the new ones, never a window beside the sentences it replaced — and so a run stopped
 * part-way leaves every earlier teaching complete and every later one untouched.
 *
 * **Outside the job ledger on purpose**, like `backfill-playback.ts`: a succeeded `embed` job
 * enqueues `cross_reference`, and this runs that step itself in the same transaction instead. The
 * ledger's partial unique index would also fold a second run into a job already waiting, which is
 * right for the chain and wrong for an operator who wants every teaching redone now.
 *
 * **It spends.** The embed step calls the provider once per sixty-four texts; the report prints
 * the calls per recording so the operator can see the cost before running it on production,
 * which is their decision and theirs alone. It also prints the link counts before and after, and
 * the five strongest links per recording with their scores — what the threshold's owner needs in
 * order to judge whether 0.70 still means what it meant on sentence vectors.
 *
 * A failure stops the run: the recording that failed is rolled back whole, and the cause is worth
 * looking at before the same mistake is made at scale.
 */
async function main(): Promise<void> {
  const recordings = await listVisibleRecordings({ includeUnpublished: true });
  if (recordings.length === 0) {
    console.log('There are no recordings. Nothing to do.');
    return;
  }

  const oldestFirst = [...recordings].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  console.log(`${oldestFirst.length} recording(s). Rebuilding each one's passage windows...`);

  const totals = { rowsBefore: 0, rowsAfter: 0, linksBefore: 0, linksAfter: 0, requests: 0 };

  for (const [index, recording] of oldestFirst.entries()) {
    const label = `${index + 1}/${oldestFirst.length} "${recording.title}" (${recording.id})`;
    const rowsBefore = countByKind(await listEmbeddingsForRecording(recording.id));
    const linksBefore = await linksOf(recording.id);
    console.log(`\n${label}`);
    console.log(`  before: ${describeCounts(rowsBefore)}; ${linksBefore.length} link(s)`);
    if (linksBefore.length > 0) await printTopLinks(linksBefore);

    const report = await withTransaction(async (tx) => {
      const deleted = await deleteEmbeddingsOfKindForRecording(recording.id, 'segment', tx);
      const embedded = await embedRecordingNow(recording.id, { executor: tx }, { cli: 'backfill-passages' });
      const linked = await crossReferenceRecordingNow(recording.id, { executor: tx }, { cli: 'backfill-passages' });
      return { deleted, embedded, linked };
    });

    const rowsAfter = countByKind(await listEmbeddingsForRecording(recording.id));
    const linksAfter = await linksOf(recording.id);
    const requests = Number(report.embedded['requests'] ?? 0);
    console.log(
      `  after:  ${describeCounts(rowsAfter)}; ${linksAfter.length} link(s); ` +
        `${report.deleted} sentence row(s) removed, ${String(report.embedded['embedded'])} row(s) embedded ` +
        `in ${requests} provider call(s), ${String(report.linked['windows'] ?? 0)} window(s) asked`,
    );
    if (linksAfter.length > 0) await printTopLinks(linksAfter);

    totals.rowsBefore += sum(rowsBefore);
    totals.rowsAfter += sum(rowsAfter);
    totals.linksBefore += linksBefore.length;
    totals.linksAfter += linksAfter.length;
    totals.requests += requests;
  }

  console.log(
    `\nBackfill complete. Embedding rows ${totals.rowsBefore} -> ${totals.rowsAfter}; ` +
      `links ${totals.linksBefore} -> ${totals.linksAfter}; ${totals.requests} provider call(s) in all.`,
  );
}

/** The links this recording's run owns, one per pair (the mirrored row is the same link). */
async function linksOf(recordingId: string): Promise<CrossReferenceRow[]> {
  const rows = await listCrossReferencesComputedFor([recordingId]);
  return rows.filter((row) => row.sourceRecordingId === recordingId);
}

/** The five strongest links, with the seek-point sentence on each end, for the threshold's owner to read. */
async function printTopLinks(links: readonly CrossReferenceRow[]): Promise<void> {
  const top = [...links].sort((a, b) => b.score - a.score).slice(0, 5);
  for (const link of top) {
    const [source, target] = await Promise.all([
      findSegmentById(link.sourceSegmentId),
      findSegmentById(link.targetSegmentId),
    ]);
    console.log(
      `    ${link.score.toFixed(4)}  "${clip(source?.text ?? '(sentence gone)')}"  ->  "${clip(target?.text ?? '(sentence gone)')}"`,
    );
  }
}

function clip(text: string): string {
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function countByKind(rows: readonly { readonly sourceKind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.sourceKind] = (counts[row.sourceKind] ?? 0) + 1;
  return counts;
}

function describeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length === 0 ? 'no embedding rows' : `${sum(counts)} embedding row(s) (${parts.join(', ')})`;
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

main().then(
  () => process.exit(0),
  (cause: unknown) => {
    console.error(
      `Backfill stopped: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        'The recording it stopped on was rolled back whole; fix the cause and run it again. ' +
        'Recordings already rebuilt are rebuilt once more, at the same provider cost.',
    );
    process.exit(1);
  },
);
