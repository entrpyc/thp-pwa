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
  /** Set when a human has corrected the machine output. */
  readonly correctedAt: string | null;
  readonly correctedByUserId: string | null;
}
