'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import {
  MAX_SEARCH_QUERY_LENGTH,
  SEARCH_FILTERS_PATH,
  chapterPagePath,
  formatTimecode,
  readSearchRequest,
  recordingPagePath,
  searchPagePath,
  searchPath,
  type SearchFiltersPayload,
  type SearchHit,
  type SearchPayload,
  type SearchRequest,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { useBreadcrumbTrail, usePlayer } from '../player-context';
import screen from '../screens.module.css';
import styles from './search.module.css';

/**
 * **The results page** ([3.10](docs/project/prd.md)) — `/search?q=…`, with every filter in the
 * address.
 *
 * **The address is the state.** The box at the top, the filters and the "only my notes" switch
 * all write to the URL and the URL is what is searched: changing a filter is a navigation to the
 * same page with one more parameter, which is what makes a search shareable, reloadable and
 * backable, and what keeps this component from holding two copies of what the member asked.
 *
 * **Rows per [3.10.6](docs/project/prd.md)**: what kind of thing matched, the teaching's title,
 * the moment, the series, and the passage in its context. **Where a row goes** is
 * [3.10.7](docs/project/prd.md): a chapter opens its page; everything else opens the recording at
 * the matched moment **without playing** ([3.2.12](docs/project/prd.md)) — the row hands the
 * teaching and the moment to the player, which loads and seeks and waits, and then navigates.
 * The recording page's own mount leaves a player already holding that teaching alone, so the
 * moment survives the navigation. If the player already holds this teaching the row seeks instead,
 * for the same reason the page would not re-open it: re-pointing the element at a fresh grant for
 * a teaching already in hand is a stall nobody asked for.
 *
 * **The two empty states are two states** ([3.10.11](docs/project/prd.md)). A search that ran
 * and found nothing says the library holds nothing for those words. A search that could not run
 * — the route failed, the server could not be reached — says search is unavailable, in a
 * different sentence, in the failure voice, and does not pretend to know anything about the
 * library. A third thing that is neither: the search ran on words alone because the provider did
 * not answer, which is a notice over results rather than an empty state.
 *
 * **Personal mind maps** ([3.10.9](docs/project/prd.md), [3.10.10](docs/project/prd.md)) do not
 * exist yet. "Only my notes" is worded for what it searches today; when mind maps arrive the
 * switch's label widens and nothing else here changes — the restriction is a parameter the server
 * interprets.
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
  | { readonly status: 'done'; readonly payload: SearchPayload }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'unavailable' };

const EMPTY_REQUEST: SearchRequest = {
  query: '',
  seriesId: null,
  recordedFrom: null,
  recordedTo: null,
  tagId: null,
  book: null,
  onlyMine: false,
};

export function SearchScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const player = usePlayer();
  useBreadcrumbTrail('Search');

  const address = params.toString();
  const check = readSearchRequest(params);
  const request: SearchRequest = check.ok ? check.request : { ...EMPTY_REQUEST, ...readLoose(params) };

  const [draft, setDraft] = useState(request.query);
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' });
  const [filters, setFilters] = useState<SearchFiltersPayload | null>(null);

  // The box follows the address, not the other way round: a back press lands on an older search
  // and the box has to say what that search was.
  useEffect(() => {
    setDraft(request.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `request` is derived from `address`
  }, [address]);

  // Asked once: what there is to narrow by changes with the library, not with the search.
  useEffect(() => {
    let live = true;
    void apiFetch<SearchFiltersPayload>(SEARCH_FILTERS_PATH, { credentials: 'include' })
      .then((payload) => {
        if (live) setFilters(payload);
      })
      .catch(() => {
        // The filters failing to load is not the search failing: the page searches without them
        // and the controls simply stay empty.
        if (live) setFilters({ series: [], tags: [], books: [] });
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (params.get('q') === null || params.get('q') === '') {
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
        if (live) setOutcome({ status: 'done', payload });
      })
      .catch((caught: unknown) => {
        if (!live) return;
        // A refusal the member can act on — the budget spent, a filter the server would not read —
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

  function go(next: Partial<SearchRequest>) {
    const merged = { ...request, ...next };
    if (merged.query.trim() === '') return;
    router.push(searchPagePath({ ...merged, query: merged.query.trim() }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go({ query: draft });
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
      player.open(
        {
          id: recording.id,
          title: recording.title,
          artworkUrl: recording.series?.artworkUrl ?? null,
          seriesTitle: recording.series?.title ?? null,
          seriesId: recording.series?.id ?? null,
        },
        startMs,
      );
    }
    router.push(recordingPagePath(recording.id));
  }

  return (
    <>
      <header className={screen.pageHead}>
        <h1 className={screen.pageTitle}>Search</h1>
        <p className={screen.pageLead}>
          Find a moment across every teaching — by what was said, or by what it meant.
        </p>
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
        The filters of 3.10.8, each a navigation. Native selects and date inputs rather than custom
        controls: they are the right size on a phone without any work, and a filter is a thing a
        member sets once per search rather than lives in.
      */}
      <fieldset className={styles.filters} aria-label="Narrow the search">
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Series</span>
          <select
            className={styles.select}
            value={request.seriesId ?? ''}
            onChange={(event) => go({ seriesId: event.target.value || null })}
          >
            <option value="">Any series</option>
            {(filters?.series ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.title}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Tag</span>
          <select
            className={styles.select}
            value={request.tagId ?? ''}
            onChange={(event) => go({ tagId: event.target.value || null })}
          >
            <option value="">Any tag</option>
            {(filters?.tags ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Book</span>
          <select
            className={styles.select}
            value={request.book ?? ''}
            onChange={(event) => go({ book: event.target.value || null })}
          >
            <option value="">Any book</option>
            {(filters?.books ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Recorded from</span>
          <input
            className={styles.select}
            type="date"
            value={request.recordedFrom ?? ''}
            onChange={(event) => go({ recordedFrom: event.target.value || null })}
          />
        </label>
        <label className={styles.filter}>
          <span className={styles.filterLabel}>Recorded to</span>
          <input
            className={styles.select}
            type="date"
            value={request.recordedTo ?? ''}
            onChange={(event) => go({ recordedTo: event.target.value || null })}
          />
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={request.onlyMine}
            onChange={(event) => go({ onlyMine: event.target.checked })}
          />
          <span>Only my notes</span>
        </label>
      </fieldset>

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

      {outcome.status === 'done' && outcome.payload.hits.length === 0 ? (
        <p className={screen.quiet} role="status" data-state="empty">
          Nothing in the library matches “{outcome.payload.query}”
          {request.onlyMine ? ' among your notes' : ''}
          {hasNarrowing(request) ? ' with these filters' : ''}.
        </p>
      ) : null}

      {outcome.status === 'done' && outcome.payload.hits.length > 0 ? (
        <ul className={styles.results} aria-label="Search results">
          {outcome.payload.hits.map((hit) => (
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
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function hasNarrowing(request: SearchRequest): boolean {
  return (
    request.seriesId !== null ||
    request.tagId !== null ||
    request.book !== null ||
    request.recordedFrom !== null ||
    request.recordedTo !== null
  );
}

/**
 * The address's filters as far as they can be read when the whole request was refused — so a
 * page refusing an empty query still shows the series the member had picked, rather than
 * forgetting it the moment they cleared the box.
 */
function readLoose(params: URLSearchParams): Partial<SearchRequest> {
  return {
    query: params.get('q') ?? '',
    seriesId: params.get('series') || null,
    tagId: params.get('tag') || null,
    book: params.get('book') || null,
    recordedFrom: params.get('from') || null,
    recordedTo: params.get('to') || null,
    onlyMine: params.get('mine') === '1',
  };
}

/** One row's content, the same inside a chapter's link and a recording's. */
function HitBody({ hit }: { hit: SearchHit }) {
  const { recording } = hit;
  const meta = [recording.series?.title ?? null, formatDay(recording.recordedAt)]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return (
    <>
      <span className={styles.hitHead}>
        <span className={styles.hitKind}>{KIND_LABEL[hit.kind]}</span>
        {hit.startMs === null ? null : (
          <span className={styles.hitTime}>{formatTimecode(hit.startMs)}</span>
        )}
      </span>
      <span className={styles.hitTitle}>{recording.title}</span>
      <span className={styles.hitMeta}>{meta}</span>
      <span className={styles.passage}>
        {hit.before === null ? null : <span className={styles.context}>{hit.before} </span>}
        <span className={styles.match}>{hit.passage}</span>
        {hit.after === null ? null : <span className={styles.context}> {hit.after}</span>}
      </span>
    </>
  );
}
