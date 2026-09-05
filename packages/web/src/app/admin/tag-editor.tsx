'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { MAX_TAG_LENGTH, normaliseTagName, type TagRef } from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './tag-editor.module.css';

/**
 * **The tags on one thing, and the field that adds one** ([4.7](docs/project/prd.md)) — the same
 * control on a recording's row and on a series' row, because a tag is the same tag on both.
 *
 * Type-to-add, and nothing more: an admin types a word, and on Enter, a comma or the press it is on
 * the item. A word that is already a tag is offered as they type (the native `datalist`, for the
 * reason the series picker is a native `select` — it is the version a phone's own keyboard
 * understands); a word that is not yet a tag becomes one in the same request. There is no separate
 * "create the tag first" step on this row — that step exists on the Tags panel for housekeeping, not
 * as a prerequisite.
 *
 * **Every change is the whole set.** Adding sends the current names plus one; removing sends them
 * minus one; the API replaces the set and the row re-reads it. There is no local list that could
 * disagree with the database after a failed press — what is drawn is always what the API last said.
 *
 * Names are normalised here before anything is compared or sent — `Grace`, `grace ` and `GRACE` are
 * one word — with the same function the server applies, so a tag already on the item is recognised
 * as already on it without a request.
 */
export function TagEditor({
  tags,
  suggestions,
  path,
  subject,
  disabled = false,
  onChanged,
}: {
  /** The tags on the item now, as the API last sent them. */
  tags: readonly TagRef[];
  /** Every tag there is, for the suggestions. The same list for every row — there is only one. */
  suggestions: readonly TagRef[];
  /** The item's own `…/tags` sub-resource, which takes the whole set by name. */
  path: string;
  /** What the item is called, for the accessible names — a row has several of these controls. */
  subject: string;
  /** Whether the row this sits on is busy with something else. */
  disabled?: boolean;
  onChanged: () => Promise<void>;
}) {
  const listId = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const applied = new Set(tags.map((one) => one.name));
  // Offer what is not already on it: a suggestion for a tag the item carries is a suggestion that
  // does nothing when taken.
  const offered = suggestions.filter((one) => !applied.has(one.name));
  const pending = normaliseTagName(draft);
  const frozen = disabled || busy;

  async function put(names: readonly string[]): Promise<void> {
    if (frozen) return;
    setBusy(true);
    setNote(null);
    try {
      await apiFetch(path, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      setDraft('');
      await onChanged();
    } catch (caught) {
      // Refused: what was typed stays in the field, and the chips stay what the API last said.
      setNote(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  function add(): void {
    if (pending === '') return;
    if (applied.has(pending)) {
      // Already on it. Clearing the field is the whole answer — a request would change nothing.
      setDraft('');
      return;
    }
    void put([...tags.map((one) => one.name), pending]);
  }

  function remove(name: string): void {
    void put(tags.filter((one) => one.name !== name).map((one) => one.name));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // Enter and comma both mean "that is the tag". The field is not in a form, so Enter would
    // otherwise do nothing; a comma is what somebody typing a list of words reaches for.
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add();
    }
  }

  return (
    <div className={styles.editor}>
      <span className={styles.label}>Tags</span>

      {tags.length === 0 ? null : (
        <ul className={styles.chips} aria-label={`Tags on ${subject}`}>
          {tags.map((one) => (
            <li key={one.id} className={styles.chip}>
              {one.name}
              <button
                className={styles.remove}
                type="button"
                aria-label={`Remove tag ${one.name} from ${subject}`}
                disabled={frozen}
                onClick={() => remove(one.name)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        className={styles.input}
        type="text"
        list={listId}
        autoComplete="off"
        aria-label={`Add a tag to ${subject}`}
        placeholder={tags.length === 0 ? 'Add a tag' : 'Add another'}
        maxLength={MAX_TAG_LENGTH}
        disabled={frozen}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <datalist id={listId}>
        {offered.map((one) => (
          <option key={one.id} value={one.name} />
        ))}
      </datalist>
      <button
        className={styles.add}
        type="button"
        disabled={frozen || pending === ''}
        onClick={add}
      >
        {busy ? 'Saving…' : 'Add tag'}
      </button>

      {note === null ? null : (
        <p className={styles.refusal} role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
