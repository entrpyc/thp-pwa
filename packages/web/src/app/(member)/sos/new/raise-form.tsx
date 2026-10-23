'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import {
  MAX_SOS_DESCRIPTION_LENGTH,
  SOS_PAGE_PATH,
  SOS_PATH,
  SOS_URGENCIES,
  SOS_URGENCY_LABEL,
  SOS_URGENCY_MEANING,
  sosPagePath,
  type RaiseSosRequest,
  type SosSignalPayload,
  type SosUrgency,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail } from '../../player-context';
import { TermsPrompt, isTermsRequired } from '../../recordings/[id]/terms-prompt';
import { UrgencyDot } from '../urgency-dot';
import styles from '../sos.module.css';

/**
 * **Raising a signal** ([3.16.1](docs/project/prd.md), [3.16.2](docs/project/prd.md)) — pick a
 * colour, say what prayer is needed, press Raise.
 *
 * The rules the feedback form holds, for the same reasons: the text survives every refusal; the
 * refusal is the API's own sentence when it had one, because "you already have ten open" and "that
 * word is not allowed" are different problems with different answers; and the picker is four
 * labelled pills rather than a dropdown, each with its meaning printed under the row, so the
 * choice is made with the PRD's own words in view.
 *
 * A member whose terms acceptance is missing or stale meets the same prompt the note composer
 * shows, in place of the form, and comes back to a form still holding their text.
 */

const CEILING_LABEL = MAX_SOS_DESCRIPTION_LENGTH.toLocaleString('en-GB');

const FAILED_MESSAGE = 'Could not raise the signal. Your text is still here — try again in a moment.';

export function RaiseForm() {
  useBreadcrumbTrail('Raise SOS', [{ label: 'SOS', href: SOS_PAGE_PATH }]);
  const router = useRouter();
  const descriptionId = useId();
  const errorId = useId();

  const [urgency, setUrgency] = useState<SosUrgency>('yellow');
  const [description, setDescription] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [termsNeeded, setTermsNeeded] = useState(false);

  const count = description.trim().length;
  const overLimit = count > MAX_SOS_DESCRIPTION_LENGTH;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sending || count === 0 || overLimit) return;
    setSending(true);
    setFailure(null);
    const request: RaiseSosRequest = { urgency, description: description.trim() };
    try {
      const payload = await apiFetch<SosSignalPayload>(SOS_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      router.push(sosPagePath(payload.signal.id));
    } catch (caught) {
      if (isTermsRequired(caught)) setTermsNeeded(true);
      else setFailure(caught instanceof ApiClientError ? caught.message : FAILED_MESSAGE);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Raise SOS</h1>
        <p className={styles.pageLead}>
          Everybody in the group is told, whatever the colour. Say how urgent it is and what prayer
          is needed.
        </p>
      </header>

      {termsNeeded ? (
        <section className={styles.card}>
          <TermsPrompt onAccepted={() => setTermsNeeded(false)} onDismiss={() => setTermsNeeded(false)} />
        </section>
      ) : (
        <form className={styles.card} onSubmit={onSubmit} aria-label="Raise SOS">
          <div className={styles.kinds} role="group" aria-label="Urgency">
            {SOS_URGENCIES.map((one) => (
              <button
                key={one}
                className={styles.kindOption}
                type="button"
                aria-pressed={urgency === one}
                onClick={() => setUrgency(one)}
              >
                <UrgencyDot urgency={one} />
                {SOS_URGENCY_LABEL[one]}
              </button>
            ))}
          </div>
          <p className={styles.kindHint}>{SOS_URGENCY_MEANING[urgency]}</p>

          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={descriptionId}>
              What prayer is needed
            </label>
            <textarea
              className={styles.textArea}
              id={descriptionId}
              name="description"
              rows={6}
              placeholder="A few sentences. The whole group will read this."
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              {...(failure === null ? {} : { 'aria-describedby': errorId })}
            />
            <p className={overLimit ? styles.countOver : styles.count}>
              {overLimit
                ? `${CEILING_LABEL} characters maximum.`
                : `${count.toLocaleString('en-GB')} / ${CEILING_LABEL}`}
            </p>
          </div>

          {failure === null ? null : (
            <p className={styles.failure} id={errorId} role="alert">
              {failure}
            </p>
          )}

          <div className={styles.actions}>
            <button
              className={styles.primary}
              type="submit"
              disabled={sending || count === 0 || overLimit}
            >
              {sending ? 'Raising…' : 'Raise SOS'}
            </button>
            <Link className={styles.link} href={SOS_PAGE_PATH}>
              Back to the board
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
