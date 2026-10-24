import { formatTimecode } from '@thp/shared';

/**
 * **The transcript as a file a member keeps** — what the `Transcript` tab's *Download* hands over.
 *
 * Nothing on the server holds a transcript file: the words live as segments, and the read route
 * answers them as a list. So the file is written here, from the lines already on screen, and it is
 * **plain text with a timecode per line** rather than a subtitle format — a member downloading a
 * teaching's transcript is going to read it or search it, not feed it to a video player, and
 * `.txt` opens everywhere without a question about what it is.
 *
 * Pure, like `current-segment.ts`: the shape of the file and of its name are decided here so a
 * test can read them without a browser, and the component only has to hand the result to the
 * platform it is running on.
 */

/** The least a line has to carry to be written out. */
export interface TranscriptLine {
  readonly startMs: number;
  readonly text: string;
}

/**
 * One line per segment, `[mm:ss] words`, in the order given, ending in a newline. The timecode is
 * the same `formatTimecode` the row shows, so what a member reads on screen and in the file agree
 * to the second.
 */
export function transcriptFileText(lines: readonly TranscriptLine[]): string {
  return lines.map((line) => `[${formatTimecode(line.startMs)}] ${line.text.trim()}\n`).join('');
}

/**
 * The file's name, from the teaching's title and — on the chapter page — the chapter's.
 *
 * Characters a filesystem refuses are replaced rather than dropped, so two titles that differ only
 * in punctuation stay two files; runs of whitespace collapse so the name reads as one. A title
 * that reduces to nothing falls back to `transcript`, because a file with no name is a file the
 * member cannot find.
 */
export function transcriptFileName(title: string, chapterTitle: string | null = null): string {
  const stem = [title, chapterTitle]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .map((part) => part.replace(/\s+/g, ' ').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-'))
    .join(' - ');
  return `${stem === '' ? 'transcript' : `${stem} - transcript`}.txt`;
}
