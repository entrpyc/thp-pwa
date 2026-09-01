'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  chapterMergePath,
  chapterPagePath,
  chapterPath,
  chapterSplitPath,
  filterChapters,
  formatTimecode,
  type ChapterView,
  type ChapterWritePayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { usePlayer } from '../../player-context';
import styles from './chapters.module.css';

/**
 * **The `Chapters` tab of the recording page** ([3.22.10](docs/project/prd.md)–
 * [3.22.12](docs/project/prd.md)).
 *
 * Every chapter in order — its number, its title and the time it starts — with a search field over
 * the list and a play control on each row.
 *
 * Four decisions worth stating:
 *
 * - **It reads the list the player already holds** rather than fetching one. The transport needs the
 *   whole list wherever the member is (project tdd 5.9), so it is fetched when the teaching is
 *   opened and this panel is drawing something the page already has. A fetch here would be a second
 *   answer to a question already answered, and the two could disagree about where a chapter ends.
 * - **The row is a link and the play control is a button** ([3.22.12](docs/project/prd.md)).
 *   Selecting a chapter opens its page and does **not** start playback — a member who tapped a
 *   chapter has not asked for sound, which is the rule opening a teaching (3.2.12) and selecting a
 *   transcript line (3.5.4) already follow. The play control beside it is the one that asks for
 *   sound, and it seeks and plays in one press.
 * - **The search field searches this teaching and nothing else**
 *   ([3.22.11](docs/project/prd.md)). Title and summary, as the member types, over the chapters in
 *   front of them; searching the library is 3.10 and is not here. The matching rule is
 *   `filterChapters` in `@thp/shared`, so what a test asserts and what a member sees are the same
 *   function.
 * - **The editing affordances grant nothing** ([3.22.7](docs/project/prd.md),
 *   [3.19.14](docs/project/prd.md)). `canEdit` decides whether they are drawn; the API is what
 *   refuses a member, which is the standing constraint every admin control on the member surface
 *   already follows.
 *
 * There is no empty state for "this teaching has no chapters", because there is no tab: the strip
 * leaves it out entirely ([3.22.4](docs/project/prd.md), [3.22.10](docs/project/prd.md)), which is
 * the line the page already draws for a teaching that cites no scripture.
 */
export function ChaptersPanel({
  recordingId,
  canEdit,
}: {
  recordingId: string;
  /** Whether to draw the edit, split and merge controls. It grants nothing — the API refuses. */
  canEdit: boolean;
}) {
  const player = usePlayer();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const chapters = player.chapters?.chapters ?? [];
  const shown = filterChapters(chapters, query);

  /**
   * Send a write and put the answer back in the player's hands.
   *
   * Every chapter write answers with the **whole list**, because a boundary move changes where the
   * chapter before it ends and a merge removes one entirely — so the panel never patches a row, it
   * takes the list the server just computed. That is also what keeps the transport's second line and
   * the track's divisions correct the moment an admin moves a boundary, without this panel knowing
   * either of them exists.
   */
  async function write(path: string, method: 'PUT' | 'POST', body?: unknown): Promise<void> {
    setFailure(null);
    try {
      const payload = await apiFetch<ChapterWritePayload>(path, {
        method,
        credentials: 'include',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      player.replaceChapters(recordingId, payload.chapters);
      setEditing(null);
      setSplitting(null);
    } catch (caught: unknown) {
      setFailure(
        caught instanceof ApiClientError
          ? caught.message
          : 'That change could not be saved. Check your connection and try again.',
      );
    }
  }

  return (
    <section className={styles.panel} aria-label="Chapters">
      {/*
        The filter, over the chapters of this teaching (3.22.11). A `search` input so a browser
        offers its own clear control, and labelled rather than placeholder-only — a placeholder
        disappears the moment somebody types, which is when they most need to know what they are
        searching.
      */}
      <label className={styles.search}>
        <span className={styles.searchLabel}>Search these chapters</span>
        <input
          className={styles.searchField}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {failure === null ? null : <p className={styles.failure}>{failure}</p>}

      {shown.length === 0 ? (
        // Only reachable through the search field, because a teaching with no chapters has no tab.
        // It says which of the two it is rather than leaving an empty box.
        <p className={styles.quiet}>No chapter of this teaching matches “{query.trim()}”.</p>
      ) : (
        <ol className={styles.list}>
          {shown.map((chapter) => (
            <li key={chapter.id} className={styles.row}>
              <div className={styles.rowMain}>
                {/*
                  **Opens the chapter's page and does not play** (3.22.12). A link, so it behaves as
                  a link does — a middle-click opens it in a tab, and it is reachable from a
                  keyboard as one press rather than as a button somebody has to guess navigates.
                */}
                <Link
                  className={styles.rowLink}
                  href={chapterPagePath(recordingId, chapter.id)}
                >
                  <span className={styles.position}>{chapter.position}</span>
                  <span className={styles.rowText}>
                    <span className={styles.title}>{chapter.title}</span>
                    <span className={styles.summary}>{chapter.summary}</span>
                  </span>
                  <time className={styles.start} dateTime={`PT${Math.round(chapter.startMs / 1000)}S`}>
                    {formatTimecode(chapter.startMs)}
                  </time>
                </Link>

                {/*
                  The one control on the row that asks for sound (3.22.12). Outside the link rather
                  than inside it, because a button inside a link is a press with two meanings.
                */}
                <button
                  className={styles.play}
                  type="button"
                  aria-label={`Play from ${chapter.title}`}
                  onClick={() => player.playFromMs(chapter.startMs)}
                >
                  <span aria-hidden="true">▶</span>
                </button>
              </div>

              {canEdit ? (
                <div className={styles.tools}>
                  <button
                    className={styles.tool}
                    type="button"
                    onClick={() => {
                      setSplitting(null);
                      setEditing((open) => (open === chapter.id ? null : chapter.id));
                    }}
                  >
                    {editing === chapter.id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    className={styles.tool}
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setSplitting((open) => (open === chapter.id ? null : chapter.id));
                    }}
                  >
                    {splitting === chapter.id ? 'Close' : 'Split'}
                  </button>
                  {/*
                    Merging removes *this* chapter's boundary, so the first chapter has none to
                    remove and the control is absent rather than drawn and refused (3.22.7).
                  */}
                  {chapter.position === 1 ? null : (
                    <button
                      className={styles.tool}
                      type="button"
                      onClick={() => void write(chapterMergePath(chapter.id), 'POST')}
                    >
                      Merge into previous
                    </button>
                  )}
                </div>
              ) : null}

              {canEdit && editing === chapter.id ? (
                <ChapterForm
                  chapter={chapter}
                  legend="Edit this chapter"
                  submitLabel="Save"
                  currentMs={player.currentMs}
                  onSubmit={(values) => void write(chapterPath(chapter.id), 'PUT', values)}
                />
              ) : null}

              {canEdit && splitting === chapter.id ? (
                <ChapterForm
                  chapter={chapter}
                  legend="Split this chapter"
                  submitLabel="Split"
                  currentMs={player.currentMs}
                  /*
                   * A split takes the *new* chapter's title and summary, so the form opens empty
                   * rather than carrying the words of the chapter being divided — which would invite
                   * an admin to press Split and end up with the same title twice.
                   */
                  blank
                  onSubmit={(values) => void write(chapterSplitPath(chapter.id), 'POST', values)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The form behind **Edit** and **Split** — the same three fields either way
 * ([3.22.7](docs/project/prd.md)).
 *
 * One component for both because they take the same values and differ only in what the server does
 * with them: an edit restates a chapter, a split states a new one. Two forms would be two places to
 * keep the boundary field's affordance in step.
 *
 * **The boundary is a number of milliseconds with a control that fills it from the player.** An
 * admin moving a boundary is listening for where the teaching turns, and the honest way to say
 * *here* is to be at the moment and press a button — typing a millisecond offset by hand is the
 * fallback rather than the path. The API refuses anything that is not a transcript line's start
 * ([3.22.5](docs/project/prd.md)), which is what makes *use where I am* safe to offer: the nearest
 * legal answer is a refusal that says so rather than a boundary inside a sentence.
 */
function ChapterForm({
  chapter,
  legend,
  submitLabel,
  currentMs,
  blank = false,
  onSubmit,
}: {
  chapter: ChapterView;
  legend: string;
  submitLabel: string;
  /** Where the player is now, so *use the current position* has something to read. */
  currentMs: number;
  blank?: boolean;
  onSubmit: (values: { title: string; summary: string; startMs: number }) => void;
}) {
  const [title, setTitle] = useState(blank ? '' : chapter.title);
  const [summary, setSummary] = useState(blank ? '' : chapter.summary);
  const [startMs, setStartMs] = useState(blank ? currentMs : chapter.startMs);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ title, summary, startMs });
      }}
    >
      <fieldset className={styles.fields}>
        <legend className={styles.legend}>{legend}</legend>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Title</span>
          <input
            className={styles.input}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Summary</span>
          <textarea
            className={styles.textarea}
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Starts at (milliseconds)</span>
          <input
            className={styles.input}
            type="number"
            min={0}
            value={startMs}
            onChange={(event) => setStartMs(Number(event.target.value))}
          />
        </label>

        <div className={styles.formActions}>
          <button
            className={styles.tool}
            type="button"
            onClick={() => setStartMs(Math.round(currentMs))}
          >
            Use the current position ({formatTimecode(currentMs)})
          </button>
          <button className={styles.submit} type="submit">
            {submitLabel}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
