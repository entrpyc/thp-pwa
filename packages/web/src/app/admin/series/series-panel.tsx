'use client';

import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  ACCEPTED_ARTWORK_TYPES,
  SERIES_PATH,
  seriesArtworkPath,
  seriesArtworkUploadsPath,
  seriesPath,
  type SeriesListPayload,
  type SeriesView,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { checkChosenArtwork, encodeArtwork } from '@/client/artwork/encode';
import styles from './series.module.css';

/**
 * The create form and the list of every series.
 *
 * A client module: it imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes.
 *
 * Three things this screen is careful about:
 *
 * 1. **A series with nothing in it is shown, not hidden.** The console is where an empty series has
 *    to be visible in order to be filled — it is created here and filled on the Recordings panel,
 *    and a list that hid it would make the second step impossible. Its count reads `0 recordings`
 *    and it has no date range, which is the honest rendering of a series nobody has put anything
 *    in yet.
 * 2. **The count here and the count a member sees can differ.** This one includes unpublished
 *    recordings; the member's does not. That falls straight out of
 *    [3.2.2](docs/project/prd.md) and is why the note under the heading says so — an admin
 *    comparing the two screens should read a rule rather than a bug.
 * 3. **Renaming is an inline form, not a separate screen.** A series is a title and a description
 *    and nothing else, so editing one is two inputs and a press.
 * 4. **A cover is set by choosing a file and nothing more.** No staging, no second press, no
 *    preview to confirm: the image is re-encoded, sent straight to the store and finalised, and the
 *    row shows what the API says the cover now is. Uploading again is how a wrong one is
 *    corrected, because there is nothing to remove one with (scope prd 3.1.5).
 */

/** One fixed rendering of a date, matching every other list in the product. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/**
 * `8 recordings · 12 Mar 2025 – 4 Jun 2025`.
 *
 * The date range is what `pages/series-inner.png`'s `2h 14m total` becomes:
 * [3.3.5](docs/project/prd.md) names the range and not a running time, and this epic stores no
 * duration anywhere. A series holding one recording prints one date rather than the same date
 * twice; a series holding none prints no range at all.
 */
export function describeSeriesMeta(series: SeriesView): string {
  const count = `${series.recordingCount} ${series.recordingCount === 1 ? 'recording' : 'recordings'}`;
  const { firstRecordedAt, lastRecordedAt } = series;
  if (firstRecordedAt === null || lastRecordedAt === null) return count;
  const range =
    firstRecordedAt === lastRecordedAt
      ? formatDay(firstRecordedAt)
      : `${formatDay(firstRecordedAt)} – ${formatDay(lastRecordedAt)}`;
  return `${count} · ${range}`;
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

export function SeriesPanel() {
  const titleId = useId();
  const descriptionId = useId();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [series, setSeries] = useState<readonly SeriesView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadSeries = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<SeriesListPayload>(SERIES_PATH, { credentials: 'include' });
      // Rendered in the order the API sent, never re-sorted here: the query orders by the most
      // recent recording in each series, and a second ordering in the client is a second answer.
      setSeries(payload.series);
      setListError(null);
    } catch (caught) {
      setSeries(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void loadSeries();
  }, [loadSeries]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      await apiFetch(SERIES_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      setDone(`${title.trim()} is created.`);
      setTitle('');
      setDescription('');
      await loadSeries();
    } catch (caught) {
      // Refused: what was typed stays exactly where it is, so being refused costs the press alone.
      setFailure(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="create-series-heading">
        <div>
          <h2 className={styles.sectionTitle} id="create-series-heading">
            Create a series
          </h2>
          <p className={styles.sectionNote}>
            A title and, if it helps, a sentence about what the study covers. Recordings are put
            into a series from the Recordings panel, where you are already reviewing them.
          </p>
        </div>

        <form className={styles.form} onSubmit={onSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={titleId}>
              Title
            </label>
            <input
              className={styles.input}
              id={titleId}
              name="title"
              type="text"
              autoComplete="off"
              disabled={busy}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={descriptionId}>
              Description
            </label>
            <textarea
              className={styles.textarea}
              id={descriptionId}
              name="description"
              rows={3}
              disabled={busy}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <button className={styles.submit} type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create series'}
          </button>

          {failure === null ? null : (
            <p className={styles.failure} role="alert">
              {failure}
            </p>
          )}
          {done === null ? null : (
            <p className={styles.done} role="status">
              {done}
            </p>
          )}
        </form>
      </section>

      <section className={styles.section} aria-labelledby="series-heading">
        <div>
          <h2 className={styles.sectionTitle} id="series-heading">
            Series
          </h2>
          <p className={styles.sectionNote}>
            Every series, most recently taught first, with the ones holding nothing yet at the end.
            These counts include unpublished recordings — a member sees only the published ones.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : series === null ? (
          <p className={styles.sectionNote}>Loading series…</p>
        ) : series.length === 0 ? (
          <p className={styles.empty}>No series yet. Create one above and it will appear here.</p>
        ) : (
          <ul className={styles.list}>
            {series.map((entry) => (
              <SeriesRow key={entry.id} entry={entry} onChanged={loadSeries} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One series, its count and range, and the inline form that renames it. */
function SeriesRow({
  entry,
  onChanged,
}: {
  entry: SeriesView;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [title, setTitle] = useState(entry.title);
  const [description, setDescription] = useState(entry.description ?? '');

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await apiFetch(seriesPath(entry.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, description }),
      });
      setEditing(false);
      await onChanged();
    } catch (caught) {
      setNote(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * **Choose an image and it is on its way** — no second press, and no staging state.
   *
   * The file input is the whole control: a picker that then waits for a "Save cover" would be a
   * form with one field in it. Three things happen in order and each one refuses before the next
   * costs anything (scope tdd 1.2, 1.3):
   *
   * 1. **The type is checked here**, against the same vocabulary the API applies, so a file the
   *    product does not accept never becomes a request.
   * 2. **The image is re-encoded here**, to one bounded WebP. What is stored is this output and not
   *    the file that was picked (scope prd 3.1.2).
   * 3. **Grant, `PUT`, finalise.** The bytes go straight to the store; nothing about them passes
   *    through the API in either direction.
   *
   * The list is re-read at the end rather than the row being patched in place, for the reason the
   * rename already re-reads: the cover a surface shows is a signed URL the API minted, and the
   * client has no business inventing one.
   */
  async function onCoverChosen(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const chosen = event.target.files?.[0];
    // Clearing the input is what makes choosing the same file twice a second upload rather than
    // nothing at all — the browser fires no change event for an unchanged value.
    event.target.value = '';
    if (chosen === undefined || busy) return;

    const complaint = checkChosenArtwork(chosen);
    if (complaint !== null) {
      setNote(complaint);
      return;
    }

    setBusy(true);
    setNote(null);
    try {
      const encoded = await encodeArtwork(chosen);
      const grant = await apiFetch<UploadGrantPayload>(seriesArtworkUploadsPath(entry.id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: chosen.name,
          contentType: encoded.contentType,
          size: encoded.blob.size,
        }),
      });

      const sent = await fetch(grant.url, {
        method: 'PUT',
        headers: { 'content-type': grant.contentType },
        body: encoded.blob,
      });
      if (!sent.ok) throw new Error('the upload did not complete');

      await apiFetch(seriesArtworkPath(entry.id), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: grant.key }),
      });
      await onChanged();
    } catch (caught) {
      setNote(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={styles.listRow}>
      {/*
       * Decorative, and deliberately unlabelled: the title is rendered beside it, and a screen
       * reader announcing the series name twice is worse than announcing it once (scope prd 4.3).
       * Absent rather than an empty frame when there is no cover (scope prd 3.2.6).
       */}
      {entry.artworkUrl === null ? null : (
        <img className={styles.rowCover} src={entry.artworkUrl} alt="" />
      )}

      <div className={styles.rowIdentity}>
        <p className={styles.rowName}>{entry.title}</p>
        {entry.description === null ? null : (
          <p className={styles.rowDescription}>{entry.description}</p>
        )}
        <p className={styles.rowMeta}>{describeSeriesMeta(entry)}</p>
      </div>

      <div className={styles.rowControls}>
        <label className={styles.action} htmlFor={`series-cover-${entry.id}`}>
          {busy ? 'Working…' : entry.artworkUrl === null ? 'Add cover' : 'Replace cover'}
        </label>
        <input
          className={styles.fileInput}
          id={`series-cover-${entry.id}`}
          name="cover"
          type="file"
          accept={ACCEPTED_ARTWORK_TYPES.join(',')}
          aria-label="Cover image"
          disabled={busy}
          onChange={(event) => void onCoverChosen(event)}
        />
        <button
          className={styles.action}
          type="button"
          disabled={busy}
          onClick={() => {
            setTitle(entry.title);
            setDescription(entry.description ?? '');
            setEditing(!editing);
          }}
        >
          {editing ? 'Cancel edit' : 'Rename'}
        </button>
      </div>

      {editing ? (
        <div className={styles.editor}>
          <label className={styles.label} htmlFor={`series-title-${entry.id}`}>
            Title
          </label>
          <input
            className={styles.input}
            id={`series-title-${entry.id}`}
            name="title"
            type="text"
            autoComplete="off"
            disabled={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className={styles.label} htmlFor={`series-description-${entry.id}`}>
            Description
          </label>
          <textarea
            className={styles.textarea}
            id={`series-description-${entry.id}`}
            name="description"
            rows={3}
            disabled={busy}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <button className={styles.submit} type="button" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save series'}
          </button>
        </div>
      ) : null}

      {note === null ? null : (
        <p className={styles.rowRefusal} role="alert">
          {note}
        </p>
      )}
    </li>
  );
}
