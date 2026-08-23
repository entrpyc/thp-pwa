/**
 * The other negative control for tools/note-privacy.ts: a notes store that reads a recording's
 * notes and never asks who is reading.
 *
 * This is the failure the guard's second half exists for. By the "written once" rule alone this
 * file is *cleaner* than the real store — it states the private-note condition zero times — and
 * every private note in the product is in its result.
 */
declare const note: { readonly recordingId: unknown };
declare function eq(column: unknown, value: unknown): unknown;

export async function listNotesForReader(recordingId: string): Promise<unknown[]> {
  return [eq(note.recordingId, recordingId)];
}
