/**
 * The timestamped segment — the atom of the transcript, and the shape the client, the API and the
 * worker all agree on. No table exists for it yet; the type does, so nothing invents a second one.
 */
export interface Segment {
  readonly id: string;
  readonly transcriptId: string;
  /** Inclusive start offset from the beginning of the recording, in milliseconds. */
  readonly startMs: number;
  /** Exclusive end offset from the beginning of the recording, in milliseconds. */
  readonly endMs: number;
  readonly text: string;
  /**
   * Who the provider heard, as its own **anonymous index** — `0`, `1`, `2`, and nothing else.
   * It is not a person and it is not a name: nothing in this product turns an index into either,
   * and the same voice is not the same index across two recordings.
   *
   * Nullable because a sentence the provider attributes to nobody is a real answer rather than a
   * defect, and because every segment written before this column existed has no answer at all.
   */
  readonly speaker: number | null;
  /** Set when a human has corrected the machine output. */
  readonly correctedAt: string | null;
  readonly correctedByUserId: string | null;
}
