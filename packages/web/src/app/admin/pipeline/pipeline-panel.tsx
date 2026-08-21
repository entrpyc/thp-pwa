'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NOT_STARTED,
  PIPELINE_PATH,
  PIPELINE_POLL_INTERVAL_MS,
  isPipelineInFlight,
  recordingRerunPath,
  type PipelineListPayload,
  type PipelineStep,
  type PipelineStepStatus,
  type PipelineStepView,
  type RecordingPipeline,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './pipeline.module.css';

/**
 * Every recording, every step, and what happened to it.
 *
 * A client module. It imports no server module, holds no database access, and calls the absolute
 * API origin like every other call the client makes. Four decisions worth stating:
 *
 * 1. **The cells come from the step list, not from this file.** A recording's row is
 *    `steps.map(…)` over what the API sent, and the API sends one entry per `PIPELINE_STEPS` entry
 *    — so [§3.4](docs/project/prd.md)'s `process_audio` arriving is a column that appears without
 *    anybody editing this screen.
 * 2. **It polls while work is in flight and stops when it is not.** A console left open on a
 *    finished pipeline should not query forever; the poll is a consequence of there being work,
 *    not a property of the screen being open. There is no manual refresh button, and no websocket
 *    — the browser asking again is the whole mechanism
 *    (docs/epics/epic-core-listening/architecture.md § Deliberately deferred).
 * 3. **A failure shows its reason in the row.** `job.error` is capped at 2000 characters by the
 *    writer and the full text is in the log under the same correlation id, but the sentence an
 *    operator needs is the one printed here.
 * 4. **A succeeded `generate_draft` reads "not built yet", not "done".** With a stub in place a
 *    recording would otherwise read as fully processed while having no draft, and the difference
 *    would be invisible. The API answers the question; this screen prints the answer.
 * 5. **Re-running `transcribe` takes a confirming press that names the recording**, and
 *    `generate_draft` does not — see {@link CONFIRMS_RERUN}. The same line the account panel draws
 *    between ending somebody's access and restoring it: the destructive direction gets the second
 *    press, and the harmless one does not.
 *
 * There is no control that cancels or stops a running job, because nothing can interrupt a claimed
 * one — which is also why `JOB_STATUSES` has no `cancelled`. Re-run is the whole of the recovery
 * story.
 */

/** One fixed rendering of a date, so a console read in two places says the same thing. */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** Timestamps on this screen are read *against each other*, so they carry the time of day. */
const MOMENT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

function formatMoment(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : MOMENT.format(parsed);
}

/** What a step is called on screen. A step with no entry here would be a compiler error. */
const STEP_LABEL: Record<PipelineStep, string> = {
  transcribe: 'Transcribe',
  generate_draft: 'Generate draft',
};

/**
 * Which steps take a **confirming press** before they run again.
 *
 * The same line the user-management panel draws, for the same reason: a re-run of `transcribe`
 * spends the provider again and replaces the transcript wholesale, discarding any corrections
 * Story 5 will let an admin make — and that should never be one stray tap on a phone standing up
 * after a service. `generate_draft` costs nothing and destroys nothing, so a confirmation there
 * would be friction with no guardrail behind it.
 *
 * `Record<PipelineStep, boolean>` rather than a list, so [§3.4](docs/project/prd.md)'s
 * `process_audio` arriving is a compiler error until somebody says whether re-running it destroys
 * something — which is the one question about a new step this screen genuinely cannot guess.
 */
const CONFIRMS_RERUN: Record<PipelineStep, boolean> = {
  transcribe: true,
  generate_draft: false,
};

/** What a status is called on screen, in the words an operator would use for it. */
const STATUS_LABEL: Record<PipelineStepStatus, string> = {
  not_started: 'Not started',
  pending: 'Waiting',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

export function PipelinePanel() {
  const [recordings, setRecordings] = useState<readonly RecordingPipeline[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** The one cell asking to be confirmed, if any. Cleared by pressing, cancelling, or acting. */
  const [confirming, setConfirming] = useState<string | null>(null);

  /**
   * The latest answer, for the poll's own use. State cannot be read from inside an interval that
   * was scheduled before it changed, and re-scheduling on every answer would restart the clock on
   * every tick.
   */
  const inFlight = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<PipelineListPayload>(PIPELINE_PATH, {
        credentials: 'include',
      });
      // Rendered in the order the API sent, never re-sorted here: the query orders by the date
      // recorded, and a second ordering in the client is a second answer to "what is most recent".
      setRecordings(payload.recordings);
      inFlight.current = isPipelineInFlight(payload.recordings);
      setListError(null);
    } catch (caught) {
      setRecordings(null);
      inFlight.current = false;
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Ask again, but only while something is moving.
   *
   * One interval for the life of the panel, which asks itself on each tick whether there is still
   * anything to ask about. That is what makes "it stops once nothing on screen is in flight" true
   * without the interval being torn down and rebuilt every time a row changes.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (inFlight.current) void load();
    }, PIPELINE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /**
   * Run one step again.
   *
   * **No precondition.** Re-running `generate_draft` on a recording whose transcript failed the
   * confidence gate is docs/project/prd.md 3.5.8's escape hatch rather than a mistake, and the API
   * refuses nothing an admin may press. Pressing twice is harmless — the second call answers with
   * the job the first one queued.
   *
   * The confirming press for the destructive step happens before this is reached; by here the
   * decision has been made.
   */
  async function rerun(recordingId: string, step: PipelineStep): Promise<void> {
    const key = `${recordingId}:${step}`;
    if (busy !== null) return;
    setBusy(key);
    setConfirming(null);
    setNotes((current) => ({ ...current, [key]: '' }));

    let note = '';
    try {
      await apiFetch(recordingRerunPath(recordingId), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step }),
      });
    } catch (caught) {
      note = describeFailure(caught);
    }

    // Whichever way it answered, the row settles into what the ledger actually holds rather than
    // into what was pressed — and the poll takes over from here, because there is now work.
    await load();
    setNotes((current) => ({ ...current, [key]: note }));
    setBusy(null);
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="pipeline-heading">
        <div>
          <h2 className={styles.sectionTitle} id="pipeline-heading">
            Pipeline
          </h2>
          <p className={styles.sectionNote}>
            Every recording and the latest attempt of each step. A step that failed says why. Run
            one again and the steps after it run behind it — a fresh transcript makes an existing
            draft wrong, and replaces the one that is there. This updates itself while anything is
            still running.
          </p>
        </div>

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : recordings === null ? (
          <p className={styles.sectionNote}>Loading pipeline…</p>
        ) : recordings.length === 0 ? (
          <p className={styles.empty}>
            No recordings yet. Upload one from the Recordings panel and its pipeline appears here.
          </p>
        ) : (
          <ul className={styles.list}>
            {recordings.map((entry) => (
              <li key={entry.recordingId} className={styles.listRow}>
                <div className={styles.rowIdentity}>
                  <p className={styles.rowName}>{entry.title}</p>
                  <p className={styles.rowMeta}>
                    Recorded <time dateTime={entry.recordedAt}>{formatDay(entry.recordedAt)}</time>
                  </p>
                </div>

                <div className={styles.steps}>
                  {entry.steps.map((step) => (
                    <StepCell
                      key={step.step}
                      step={step}
                      title={entry.title}
                      busy={busy === `${entry.recordingId}:${step.step}`}
                      disabled={busy !== null}
                      confirming={confirming === `${entry.recordingId}:${step.step}`}
                      note={notes[`${entry.recordingId}:${step.step}`] ?? ''}
                      onAsk={() => setConfirming(`${entry.recordingId}:${step.step}`)}
                      onCancel={() => setConfirming(null)}
                      onRerun={() => void rerun(entry.recordingId, step.step)}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One step of one recording: what it is, what happened, when, and the way to run it again. */
function StepCell({
  step,
  title,
  busy,
  disabled,
  confirming,
  note,
  onAsk,
  onCancel,
  onRerun,
}: {
  step: PipelineStepView;
  title: string;
  busy: boolean;
  disabled: boolean;
  confirming: boolean;
  note: string;
  onAsk: () => void;
  onCancel: () => void;
  onRerun: () => void;
}) {
  // "Succeeded" on a step nothing has built yet would be the ledger telling the truth and the
  // screen implying something else.
  const status = step.stub ? 'Not built yet' : STATUS_LABEL[step.status];

  return (
    <div className={styles.step}>
      <p className={styles.stepName}>{STEP_LABEL[step.step]}</p>

      <p className={styles.stepStatus} data-status={step.status} data-stub={step.stub}>
        {status}
        {step.attempt === null ? null : (
          <span className={styles.attempt}> · attempt {step.attempt}</span>
        )}
      </p>

      {step.status === NOT_STARTED ? null : (
        <dl className={styles.times}>
          <Moment label="Queued" iso={step.enqueuedAt} />
          <Moment label="Started" iso={step.startedAt} />
          <Moment label="Finished" iso={step.finishedAt} />
        </dl>
      )}

      {step.error === null ? null : (
        <p className={styles.reason}>{step.error}</p>
      )}

      {step.stub ? (
        <p className={styles.stepNote}>
          Nothing was generated — this step is a placeholder until drafting is built.
        </p>
      ) : null}

      <button
        className={styles.action}
        type="button"
        disabled={disabled}
        onClick={CONFIRMS_RERUN[step.step] && !confirming ? onAsk : onRerun}
      >
        {busy ? 'Queueing…' : 'Run again'}
      </button>

      {/*
        The confirming press, and only for the step that destroys something. It names the recording
        and says what running it again costs — the two facts an admin needs and the row above does
        not carry.
      */}
      {confirming ? (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            Transcribe “{title}” again? It is sent to the provider a second time, and the transcript
            it has now is replaced.
          </p>
          <div className={styles.confirmActions}>
            <button
              className={styles.actionStrong}
              type="button"
              disabled={disabled}
              onClick={onRerun}
            >
              Yes, transcribe again
            </button>
            <button className={styles.action} type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {note === '' ? null : (
        <p className={styles.reason} role="alert">
          {note}
        </p>
      )}
    </div>
  );
}

/** One of the three transitions the ledger holds. No duration is computed from them. */
function Moment({ label, iso }: { label: string; iso: string | null }) {
  if (iso === null) return null;
  return (
    <>
      <dt className={styles.timeLabel}>{label}</dt>
      <dd className={styles.timeValue}>
        <time dateTime={iso}>{formatMoment(iso)}</time>
      </dd>
    </>
  );
}
