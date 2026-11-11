'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  RELEASE_NOTES_PATH,
  releaseNotePagePath,
  releaseNotePath,
  releaseNoteSourcePath,
  type DeleteReleaseNotePayload,
  type ReleaseNoteListPayload,
  type ReleaseNoteSource,
  type ReleaseNoteSourcePayload,
  type ReleaseNoteSummary,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import { ReleaseNoteEditor } from './release-note-editor';
import styles from './release-notes.module.css';

/**
 * **The release notes panel** — every post, and the way to write, change and remove one.
 *
 * A client module: it imports no server module and calls the API like every other panel.
 *
 * - **A post is published by saving it.** There is no draft state: the list members read is this
 *   list. Announcing a post is a separate act, on the Announcements panel, where a new-feature
 *   notice picks one of these to open.
 * - **Deleting takes a confirming press** and says what else it does: notifications that opened
 *   the post are moved to the list of release notes rather than left on a missing page.
 * - **The list is the API's order** — newest first — and is read again after every write.
 */

type Mode =
  | { readonly kind: 'list' }
  | { readonly kind: 'new' }
  | { readonly kind: 'edit'; readonly source: ReleaseNoteSource };

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** `Published 5 Sept 2026, 10:12` — and when it was last changed, if it has been. */
export function describePost(post: ReleaseNoteSummary): string {
  const published = `Published ${formatDay(post.publishedAt)}`;
  return post.updatedAt === post.publishedAt ? published : `${published} · edited ${formatDay(post.updatedAt)}`;
}

export function ReleaseNotesPanel() {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [posts, setPosts] = useState<readonly ReleaseNoteSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<ReleaseNoteListPayload>(RELEASE_NOTES_PATH, {
        credentials: 'include',
      });
      setPosts(payload.releaseNotes);
      setListError(null);
    } catch (caught) {
      setPosts(null);
      setListError(describeFailure(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openForEdit(id: string): Promise<void> {
    if (opening !== null) return;
    setOpening(id);
    setFailure(null);
    setDone(null);
    setConfirming(null);
    try {
      const payload = await apiFetch<ReleaseNoteSourcePayload>(releaseNoteSourcePath(id), {
        credentials: 'include',
      });
      setMode({ kind: 'edit', source: payload.releaseNote });
    } catch (caught) {
      setFailure(describeFailure(caught));
    } finally {
      setOpening(null);
    }
  }

  async function remove(post: ReleaseNoteSummary): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setFailure(null);
    setDone(null);
    try {
      await apiFetch<DeleteReleaseNotePayload>(releaseNotePath(post.id), {
        method: 'DELETE',
        credentials: 'include',
      });
      setDone(`“${post.title}” is deleted.`);
      setConfirming(null);
      await load();
    } catch (caught) {
      setFailure(describeFailure(caught));
      setConfirming(null);
    } finally {
      setDeleting(false);
    }
  }

  if (mode.kind !== 'list') {
    return (
      <div className={styles.panel}>
        <section className={styles.section} aria-labelledby="release-note-editor-heading">
          <div>
            <h2 className={styles.sectionTitle} id="release-note-editor-heading">
              {mode.kind === 'new' ? 'New release note' : 'Edit release note'}
            </h2>
            <p className={styles.sectionNote}>
              {mode.kind === 'new'
                ? 'Members can read it as soon as it is published. Nobody is notified until you send a new-feature notice from Announcements.'
                : 'Members see the changes as soon as they are saved.'}
            </p>
          </div>
          <ReleaseNoteEditor
            // A different post is a different editor: the document is read once, at mount.
            key={mode.kind === 'edit' ? mode.source.id : 'new'}
            source={mode.kind === 'edit' ? mode.source : null}
            onCancel={() => setMode({ kind: 'list' })}
            onSaved={(saved, created) => {
              setMode({ kind: 'list' });
              setDone(created ? `“${saved.title}” is published.` : `“${saved.title}” is saved.`);
              void load();
            }}
          />
        </section>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="release-notes-heading">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle} id="release-notes-heading">
              Release notes
            </h2>
            <p className={styles.sectionNote}>
              Posts that say what is new. Members read them under “Release notes” in the menu.
            </p>
          </div>
          <button
            className={styles.submit}
            type="button"
            onClick={() => {
              setFailure(null);
              setDone(null);
              setConfirming(null);
              setMode({ kind: 'new' });
            }}
          >
            New post
          </button>
        </div>

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

        {listError !== null ? (
          <p className={styles.failure} role="alert">
            {listError}
          </p>
        ) : posts === null ? (
          <p className={styles.sectionNote}>Loading…</p>
        ) : posts.length === 0 ? (
          <p className={styles.empty}>No posts yet. The first one will appear here.</p>
        ) : (
          <ul className={styles.list} aria-label="Release notes">
            {posts.map((post) => (
              <li className={styles.listRow} key={post.id}>
                <div className={styles.rowIdentity}>
                  <p className={styles.rowName}>{post.title}</p>
                  {post.excerpt === '' ? null : <p className={styles.rowBody}>{post.excerpt}</p>}
                  <p className={styles.rowMeta}>{describePost(post)}</p>
                </div>
                {confirming === post.id ? (
                  <div className={styles.confirm}>
                    <p className={styles.confirmText}>
                      Delete “{post.title}”? Notifications that opened it will open the list of
                      release notes instead. It cannot be undone.
                    </p>
                    <div className={styles.confirmActions}>
                      <button
                        className={styles.actionStrong}
                        type="button"
                        disabled={deleting}
                        onClick={() => void remove(post)}
                      >
                        {deleting ? 'Deleting…' : 'Yes, delete it'}
                      </button>
                      <button
                        className={styles.action}
                        type="button"
                        disabled={deleting}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.rowControls}>
                    <Link className={styles.action} href={releaseNotePagePath(post.id)}>
                      View
                    </Link>
                    <button
                      className={styles.action}
                      type="button"
                      aria-label={`Edit ${post.title}`}
                      disabled={opening !== null}
                      onClick={() => void openForEdit(post.id)}
                    >
                      {opening === post.id ? 'Opening…' : 'Edit'}
                    </button>
                    <button
                      className={styles.action}
                      type="button"
                      aria-label={`Delete ${post.title}`}
                      onClick={() => {
                        setFailure(null);
                        setDone(null);
                        setConfirming(post.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
