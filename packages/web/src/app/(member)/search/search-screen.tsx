'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import {
  DEFAULT_SEARCH_CONTROLS,
  MAX_SEARCH_QUERY_LENGTH,
  SEARCH_BLEND_LABELS,
  SEARCH_BLEND_STOPS,
  SEARCH_KIND_LABELS,
  SEARCH_KIND_ORDER,
  SEARCH_PER_TEACHING_OPTIONS,
  SEARCHABLE_KINDS,
  WORDS_MATCH_LABEL,
  chapterPagePath,
  formatTimecode,
  meaningLabel,
  readSearchControls,
  readSearchRequest,
  recordingPagePath,
  searchPagePath,
  searchPath,
  splitMarkedPassage,
  type SearchControls,
  type SearchHit,
  type SearchPayload,
  type SearchRequest,
  type SearchableKind,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer, type LoadedRecording } from '../player-context';
import screen from '../screens.module.css';
import styles from './search.module.css';

/**
 * **The results page** ([3.10](docs/project/prd.md)) — `/search?q=…`, with every control in the
 * address.
 *
 * **The address is the state.** The box at the top, the content types, the words/meaning choice
 * and the per-teaching select all write to the URL and the URL is what is searched: changing a
 * control is a navigation to the same page with one more parameter, which is what makes a search
 * shareable, reloadable and backable, and what keeps this component from holding two copies of
 * what the member asked. A control at its default is left out of the address. **The controls do
 * not wait for words**: a member may narrow the content types or pick "Meaning only" before they
 * have typed anything, and the address carries the controls alone until the search is submitted
 * — the controls are read by `readSearchControls`, which needs no query, and the query by
 * `readSearchRequest`, which needs the controls. The one thing not in the address is how many
 * pages have been shown: "Show more" asks the route for the next ten by offset and appends them,
 * and a reload starts at the first page again.
 *
 * **Rows per [3.10.6](docs/project/prd.md)**: what kind of thing matched, the teaching's title,
 * the moment, the series, the passage in its context, and **how it matched** — a meaning label
 * bucketed from the similarity (never the number), a words label with the matched terms in bold,
 * or both. An admin also gets a disclosure with the raw ranks and scores, for tuning. **Where a
 * row goes** is [3.10.7](docs/project/prd.md): a chapter opens its page; everything else opens the
 * recording at the matched moment **without playing** ([3.2.12](docs/project/prd.md)) — the row
 * hands the teaching and the moment to the player, which loads and seeks and waits, and then
 * navigates. If the player already holds this teaching the row seeks instead. **The moment itself
 * is a play control**: pressing the timecode on a row plays the teaching from there in the docked
 * transport and stays on the results, so a member can listen to a hit, decide it is not the one,
 * and press the next — the row's link is still the way to the page.
 *
 * **The two empty states are two states** ([3.10.11](docs/project/prd.md)). A search that ran
 * and found nothing says the library holds nothing for those words. A search that could not run
 * — the route failed, the server could not be reached — says search is unavailable, in a
 * different sentence, in the failure voice, and does not pretend to know anything about the
 * library. A third thing that is neither: the search ran on words alone because the provider did
 * not answer, which is a notice over results rather than an empty state.
 */

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDay(iso: string): string {
  const parsed = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  segment: 'Recording',
  chapter: 'Chapter',
  note: 'Note',
  summary: 'Summary',
  recording: 'Teaching',
};

type Outcome =
  | { readonly status: 'idle' }
  | { readonly status: 'invalid'; readonly problem: string }
  | { readonly status: 'loading' }
  | {
      readonly status: 'done';
      readonly payload: SearchPayload;
      /** Every page shown so far, the first page's hits first. */
      readonly hits: readonly SearchHit[];
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
    }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'unavailable' };

/** The teaching a hit belongs to, as the player wants it handed over. */
function loadedFrom(hit: SearchHit): LoadedRecording {
  const { recording } = hit;
  return {
    id: recording.id,
    title: recording.title,
    artworkUrl: recording.series?.artworkUrl ?? null,
    seriesTitle: recording.series?.title ?? null,
    seriesId: recording.series?.id ?? null,
  };
}

export function SearchScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const player = usePlayer();
  useBreadcrumbTrail('Search');

  const address = params.toString();
  const query = params.get('q') ?? '';
  // The controls stand on their own, so an unreadable one is shown at its default rather than
  // taking the others with it; the request is what the route is asked, and needs the words too.
  const controlsCheck = readSearchControls(params);
  const controls: SearchControls = controlsCheck.ok ? controlsCheck.controls : DEFAULT_SEARCH_CONTROLS;
  const check = readSearchRequest(params);
  const request: SearchRequest = { ...controls, query };

  const [draft, setDraft] = useState(query);
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });

  // The box follows the address, not the other way round: a back press lands on an older search
  // and the box has to say what that search was.
  useEffect(() => {
    setDraft(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `query` is derived from `address`
  }, [address]);

  useEffect(() => {
    if (query === '') {
      setOutcome({ status: 'idle' });
      return;
    }
    if (!check.ok) {
      setOutcome({ status: 'invalid', problem: check.problem });
      return;
    }
    let live = true;
    setOutcome({ status: 'loading' });
    void apiFetch<SearchPayload>(searchPath(check.request), { credentials: 'include' })
      .then((payload) => {
        if (live) {
          setOutcome({ status: 'done', payload, hits: payload.hits, hasMore: payload.hasMore, loadingMore: false });
        }
      })
      .catch((caught: unknown) => {
        if (!live) return;
        // A refusal the member can act on — the budget spent, a control the server would not read —
        // is shown in its own words. Everything else is "unavailable": a `500`, a network failure, a
        // body that was not JSON. The member is told search is down, not what the library holds.
        if (
          caught instanceof ApiClientError &&
          (caught.code === 'rate_limited' || caught.code === 'invalid_input')
        ) {
          setOutcome({ status: 'refused', message: caught.message });
        } else {
          setOutcome({ status: 'unavailable' });
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `check` is derived from `address`
  }, [address]);

  /**
   * Write a change to the address. With words, that is the next search; without, it is the
   * controls alone, kept for the search to come.
   */
  function go(next: Partial<SearchRequest>) {
    const merged = { ...request, ...next, offset: 0 };
    router.push(searchPagePath({ ...merged, query: merged.query.trim() }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go({ query: draft });
  }

  function toggleKind(kind: SearchableKind, on: boolean) {
    const chosen = new Set(request.kinds);
    if (on) chosen.add(kind);
    else chosen.delete(kind);
    // Nothing ticked is everything: an empty search is not a search a member meant.
    const kinds = chosen.size === 0 ? SEARCHABLE_KINDS : SEARCHABLE_KINDS.filter((one) => chosen.has(one));
    go({ kinds });
  }

  /** The next ten, appended. A second request under the same budget; the address does not change. */
  function showMore() {
    if (outcome.status !== 'done' || !check.ok || outcome.loadingMore) return;
    const shown = outcome;
    setOutcome({ ...shown, loadingMore: true });
    void apiFetch<SearchPayload>(
      // The address always asks for the first page, so what is shown is exactly the offset.
      searchPath({ ...check.request, offset: shown.hits.length }),
      { credentials: 'include' },
    )
      .then((payload) => {
        setOutcome((current) =>
          current.status === 'done'
            ? { ...current, hits: [...current.hits, ...payload.hits], hasMore: payload.hasMore, loadingMore: false }
            : current,
        );
      })
      .catch(() => {
        // The page the member has is still good; the one that failed is simply not appended, and
        // the control stays for another press.
        setOutcome((current) => (current.status === 'done' ? { ...current, loadingMore: false } : current));
      });
  }

  /**
   * Open the teaching at the moment, without playing, then go to its page. See the module comment.
   */
  function openAtMoment(event: MouseEvent<HTMLAnchorElement>, hit: SearchHit) {
    // A modified click — new tab, new window — is the browser's to handle, and the plain link
    // underneath is a correct address for it; only the ordinary press is taken over.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    const { recording, startMs } = hit;
    if (player.loaded?.id === recording.id) {
      if (startMs !== null) player.seekToMs(startMs);
    } else {
      player.open(loadedFrom(hit), startMs);
    }
    router.push(recordingPagePath(recording.id));
  }

  /**
   * Play the teaching from the moment, here, in the docked transport. The page stays where it is:
   * the member asked to hear the hit, not to leave the results.
   */
  function playFromMoment(hit: SearchHit, startMs: number) {
    if (player.loaded?.id === hit.recording.id) {
      player.playFromMs(startMs);
    } else {
      player.openAndPlay(loadedFrom(hit), startMs);
    }
  }

  const perTeachingParam =
    SEARCH_PER_TEACHING_OPTIONS.find((one) => one.value === request.perTeaching)?.param ?? '3';

  return (
    <>
      <header className={screen.pageHead}>
        <h1 className={screen.pageTitle}>Search</h1>
      </header>

      <form className={styles.searchForm} role="search" onSubmit={submit}>
        <label className={styles.queryField}>
          <span className={styles.srOnly}>Search for</span>
          <input
            className={styles.queryInput}
            type="search"
            name="q"
            value={draft}
            maxLength={MAX_SEARCH_QUERY_LENGTH}
            placeholder="Search the library"
            autoComplete="off"
            enterKeyHint="search"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className={styles.submit} type="submit">
          Search
        </button>
      </form>

      {/*
        The controls, each a navigation: which kinds of thing are searched, how the two arms are
        weighed, and how many moments of one teaching may fill the page. The boxes and the radios
        are the product's own — the native ones are a different size on every platform and never
        the product's colour — drawn as chips a thumb can land on.
      */}
      <div className={styles.controls}>
        <fieldset className={styles.choices} aria-label="Content type">
          <legend className={styles.controlLabel}>Content type</legend>
          <div className={styles.chips}>
            {SEARCH_KIND_ORDER.map((kind) => (
              <label key={kind} className={styles.chip}>
                <input
                  className={styles.box}
                  type="checkbox"
                  name="kinds"
                  value={kind}
                  checked={request.kinds.includes(kind)}
                  onChange={(event) => toggleKind(kind, event.target.checked)}
                />
                <span>{SEARCH_KIND_LABELS[kind]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.choices} aria-label="Words / meaning">
          <legend className={styles.controlLabel}>Words / meaning</legend>
          <div className={styles.chips}>
            {SEARCH_BLEND_STOPS.map((stop) => (
              <label key={stop} className={styles.chip}>
                <input
                  className={`${styles.box} ${styles.radio}`}
                  type="radio"
                  name="mix"
                  value={stop}
                  checked={request.blend === stop}
                  onChange={() => {
                    if (stop !== request.blend) go({ blend: stop });
                  }}
                />
                <span>{SEARCH_BLEND_LABELS[stop]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className={styles.perTeaching}>
          <span className={styles.controlLabel}>Per teaching</span>
          <select
            className={styles.select}
            name="per"
            value={perTeachingParam}
            onChange={(event) => {
              const option = SEARCH_PER_TEACHING_OPTIONS.find((one) => one.param === event.target.value);
              if (option !== undefined) go({ perTeaching: option.value });
            }}
          >
            {SEARCH_PER_TEACHING_OPTIONS.map((option) => (
              <option key={option.param} value={option.param}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {outcome.status === 'idle' ? (
        <p className={screen.quiet}>Type what you are looking for and press Search.</p>
      ) : null}

      {outcome.status === 'invalid' || outcome.status === 'refused' ? (
        <p className={screen.failure} role="alert">
          {outcome.status === 'invalid' ? outcome.problem : outcome.message}
        </p>
      ) : null}

      {outcome.status === 'loading' ? <p className={screen.quiet}>Searching…</p> : null}

      {outcome.status === 'unavailable' ? (
        <p className={screen.failure} role="alert" data-state="unavailable">
          Search is unavailable right now. Check your connection and try again in a moment.
        </p>
      ) : null}

      {outcome.status === 'done' && !outcome.payload.meaningAvailable ? (
        <p className={styles.notice} role="status">
          Showing matches on exact words only. Search by meaning is unavailable right now.
        </p>
      ) : null}

      {outcome.status === 'done' && outcome.hits.length === 0 ? (
        <p className={screen.quiet} role="status" data-state="empty">
          Nothing in the library matches “{outcome.payload.query}”.
        </p>
      ) : null}

      {outcome.status === 'done' && outcome.hits.length > 0 ? (
        <>
          <ul className={styles.results} aria-label="Search results">
            {outcome.hits.map((hit) => (
              <li key={hit.id} className={styles.result}>
                {hit.kind === 'chapter' ? (
                  <Link className={styles.hit} href={chapterPagePath(hit.recording.id, hit.sourceId)}>
                    <HitBody hit={hit} />
                  </Link>
                ) : (
                  <a
                    className={styles.hit}
                    href={recordingPagePath(hit.recording.id)}
                    onClick={(event) => openAtMoment(event, hit)}
                  >
                    <HitBody hit={hit} />
                  </a>
                )}
                {/*
                  The moment, as a control beside the link rather than inside it — a button inside
                  an anchor is two controls in one press. It sits where the timecode has always
                  been drawn, at the head's right edge, and the head leaves it the room.
                */}
                {hit.startMs === null ? null : (
                  <button
                    type="button"
                    className={styles.hitTime}
                    aria-label={`Play from ${formatTimecode(hit.startMs)}`}
                    onClick={() => playFromMoment(hit, hit.startMs ?? 0)}
                  >
                    <span aria-hidden="true" className={styles.hitTimeGlyph}>
                      ▶
                    </span>
                    {formatTimecode(hit.startMs)}
                  </button>
                )}
                {outcome.payload.showScores ? <Scores hit={hit} /> : null}
              </li>
            ))}
          </ul>
          {outcome.hasMore ? (
            <div className={styles.more}>
              <button
                type="button"
                className={styles.showMore}
                onClick={showMore}
                disabled={outcome.loadingMore}
              >
                {outcome.loadingMore ? 'Loading…' : 'Show more'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** One row's content, the same inside a chapter's link and a recording's. */
function HitBody({ hit }: { hit: SearchHit }) {
  const { recording } = hit;
  const meta = [recording.series?.title ?? null, formatDay(recording.recordedAt)]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const labels: string[] = [];
  if (hit.matchedBy.includes('meaning') && hit.similarity !== null) labels.push(meaningLabel(hit.similarity));
  if (hit.matchedBy.includes('words')) labels.push(WORDS_MATCH_LABEL);
  return (
    <>
      <span className={styles.hitHead} data-has-time={hit.startMs === null ? undefined : ''}>
        <span className={styles.hitKind}>{KIND_LABEL[hit.kind]}</span>
      </span>
      <span className={styles.hitTitle}>{recording.title}</span>
      <span className={styles.hitMeta}>{meta}</span>
      <span className={styles.passage}>
        {hit.before === null ? null : <span className={styles.context}>{hit.before} </span>}
        <span className={styles.match}>
          {splitMarkedPassage(hit.passageMarked).map((run, index) =>
            run.matched ? (
              <strong key={index} className={styles.term}>
                {run.text}
              </strong>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
        </span>
        {hit.after === null ? null : <span className={styles.context}> {hit.after}</span>}
      </span>
      {labels.length > 0 ? (
        <span className={styles.matchLabels} data-testid="match-labels">
          {labels.map((label) => (
            <span key={label} className={styles.matchLabel}>
              {label}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

/** The raw numbers, for an operator. Drawn only when the payload says the actor may see them. */
function Scores({ hit }: { hit: SearchHit }) {
  const { scores } = hit;
  const fixed = (value: number | null, places: number) => (value === null ? '—' : value.toFixed(places));
  return (
    <details className={styles.scores} data-testid="scores">
      <summary className={styles.scoresSummary}>Scores</summary>
      <dl className={styles.scoresList}>
        <dt>Vector rank</dt>
        <dd>{scores.vectorRank ?? '—'}</dd>
        <dt>Text rank</dt>
        <dd>{scores.textRank ?? '—'}</dd>
        <dt>Similarity</dt>
        <dd>{fixed(scores.similarity, 3)}</dd>
        <dt>Fused score</dt>
        <dd>{fixed(scores.score, 5)}</dd>
      </dl>
    </details>
  );
}
