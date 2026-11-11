'use client';

import { useId, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from 'react';
import Image from '@tiptap/extension-image';
import Youtube from '@tiptap/extension-youtube';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  ACCEPTED_RELEASE_NOTE_IMAGE_LABEL,
  ACCEPTED_RELEASE_NOTE_IMAGE_TYPES,
  MAX_RELEASE_NOTE_IMAGE_BYTES,
  MAX_RELEASE_NOTE_IMAGE_LABEL,
  MAX_RELEASE_NOTE_TITLE_LENGTH,
  RELEASE_NOTES_PATH,
  RELEASE_NOTE_IMAGE_UPLOADS_PATH,
  isAcceptedReleaseNoteImageType,
  isSafeReleaseNoteHref,
  releaseNotePath,
  youtubeVideoId,
  youtubeWatchUrl,
  type ReleaseNoteSource,
  type ReleaseNoteSummary,
  type SaveReleaseNotePayload,
  type SaveReleaseNoteRequest,
  type UploadGrantPayload,
} from '@thp/shared';
import { ApiClientError, apiFetch } from '@/client/api-client';
import styles from './release-notes.module.css';

/**
 * **The post editor** — a title and a rich-text body.
 *
 * The body is edited as a document and sent as one: what leaves this screen is the editor's own
 * tree, and the server's parser (`parseReleaseNoteDoc`) is what decides it is a post. Nothing here
 * is the authority on what a post may contain; this only offers the controls for what it may.
 *
 * Three things it is careful about:
 *
 * 1. **A picture is uploaded before it is in the post.** Choosing a file asks for a grant, sends
 *    the bytes to the store, and only then inserts the picture, carrying the upload key the save
 *    will name. A GIF is sent as it is — re-encoding one would keep its first frame only.
 * 2. **A video is a YouTube link, read here before it is inserted**, so a link that names no video
 *    is refused beside the button rather than at the save.
 * 3. **A refused save keeps everything.** The message is printed and the form stays as it was.
 */

/** The image node, with the upload key riding beside the URL the editor paints. */
const PostImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      key: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-key'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes['key'] === 'string' ? { 'data-key': attributes['key'] } : {},
      },
    };
  },
});

const EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] },
  }),
  PostImage.configure({ allowBase64: false }),
  Youtube.configure({ nocookie: true, modestBranding: true, width: 640, height: 360 }),
];

/** The stored post as the editor holds it: a video is the link the YouTube node reads. */
function toEditorContent(node: unknown): JSONContent {
  const one = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if (one.type === 'youtube' && typeof one.attrs?.['videoId'] === 'string') {
    return { type: 'youtube', attrs: { src: youtubeWatchUrl(one.attrs['videoId']) } };
  }
  const copy = { ...(one as JSONContent) };
  if (Array.isArray(one.content)) copy.content = one.content.map(toEditorContent);
  return copy;
}

/**
 * A press on a toolbar button must not take the caret out of the post: the button acts on the
 * selection, and typing carries on where it was. Keyboard focus still reaches the buttons by Tab.
 */
function keepSelection(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

function describeFailure(caught: unknown): string {
  return caught instanceof ApiClientError
    ? caught.message
    : 'Could not reach the server. Check your connection and try again.';
}

async function uploadPicture(file: File): Promise<{ key: string; src: string }> {
  const grant = await apiFetch<UploadGrantPayload>(RELEASE_NOTE_IMAGE_UPLOADS_PATH, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
  });
  const sent = await fetch(grant.url, {
    method: 'PUT',
    headers: { 'content-type': grant.contentType },
    body: file,
  });
  if (!sent.ok) throw new Error('the upload did not complete');
  // Painted from the bytes on this device until the post is saved and read back signed.
  return { key: grant.key, src: URL.createObjectURL(file) };
}

interface ToolButton {
  readonly label: string;
  readonly text: string;
  readonly active?: (editor: Editor) => boolean;
  readonly run: (editor: Editor) => void;
}

const TOOLS: readonly ToolButton[] = [
  { label: 'Bold', text: 'B', active: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { label: 'Italic', text: 'I', active: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  {
    label: 'Underline',
    text: 'U',
    active: (e) => e.isActive('underline'),
    run: (e) => e.chain().focus().toggleUnderline().run(),
  },
  {
    label: 'Strikethrough',
    text: 'S',
    active: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    label: 'Heading',
    text: 'Heading',
    active: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Subheading',
    text: 'Subheading',
    active: (e) => e.isActive('heading', { level: 3 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: 'Bullet list',
    text: '• List',
    active: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    text: '1. List',
    active: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    text: 'Quote',
    active: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    label: 'Code block',
    text: 'Code',
    active: (e) => e.isActive('codeBlock'),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  { label: 'Divider', text: 'Divider', run: (e) => e.chain().focus().setHorizontalRule().run() },
];

export function ReleaseNoteEditor({
  source,
  onSaved,
  onCancel,
}: {
  /** The post being edited, or `null` for a new one. */
  source: ReleaseNoteSource | null;
  onSaved: (saved: ReleaseNoteSummary, created: boolean) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(source?.title ?? '');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: source === null ? '' : toEditorContent(source.body),
    // Rendered after mount: the console is server-rendered and the editor is not.
    immediatelyRender: false,
    // The toolbar reads the selection's marks, so it repaints with every transaction.
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { 'aria-label': 'Post', role: 'textbox', 'aria-multiline': 'true' } },
  });

  function addLink(): void {
    if (editor === null) return;
    const current = editor.getAttributes('link')['href'];
    const typed = window.prompt('Link address', typeof current === 'string' ? current : 'https://');
    if (typed === null) return;
    const href = typed.trim();
    if (href === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!isSafeReleaseNoteHref(href)) {
      setFailure('That is not a web address this accepts. Start it with https://.');
      return;
    }
    setFailure(null);
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }

  function addVideo(): void {
    if (editor === null) return;
    const typed = window.prompt('YouTube link');
    if (typed === null || typed.trim() === '') return;
    const videoId = youtubeVideoId(typed);
    if (videoId === null) {
      setFailure('That is not a YouTube link this can read. Paste the video’s address.');
      return;
    }
    setFailure(null);
    editor.chain().focus().setYoutubeVideo({ src: youtubeWatchUrl(videoId) }).run();
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Cleared at once, so choosing the same file again is still a change.
    event.target.value = '';
    if (file === undefined || editor === null) return;
    if (!isAcceptedReleaseNoteImageType(file.type)) {
      setFailure(`That is not an image this accepts. Upload ${ACCEPTED_RELEASE_NOTE_IMAGE_LABEL}.`);
      return;
    }
    if (file.size > MAX_RELEASE_NOTE_IMAGE_BYTES) {
      setFailure(`That picture is too large; the limit is ${MAX_RELEASE_NOTE_IMAGE_LABEL}.`);
      return;
    }
    setFailure(null);
    setUploading(true);
    try {
      const { key, src } = await uploadPicture(file);
      const alt = window.prompt('Describe the picture for people who cannot see it (optional)') ?? '';
      editor
        .chain()
        .focus()
        .insertContent({ type: 'image', attrs: { src, key, alt: alt.trim() === '' ? null : alt.trim() } })
        .run();
    } catch (caught) {
      setFailure(
        caught instanceof ApiClientError ? caught.message : 'The picture did not upload. Try it again.',
      );
    } finally {
      setUploading(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || uploading || editor === null) return;
    setBusy(true);
    setFailure(null);
    const request: SaveReleaseNoteRequest = { title, body: editor.getJSON() };
    try {
      const payload = await apiFetch<SaveReleaseNotePayload>(
        source === null ? RELEASE_NOTES_PATH : releaseNotePath(source.id),
        {
          method: source === null ? 'POST' : 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      onSaved(payload.releaseNote, source === null);
    } catch (caught) {
      setFailure(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || editor === null;

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)} noValidate>
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
          maxLength={MAX_RELEASE_NOTE_TITLE_LENGTH}
          disabled={busy}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Post</span>
        <div className={styles.editor}>
          <div className={styles.toolbar} role="toolbar" aria-label="Formatting">
            {TOOLS.map((tool) => (
              <button
                key={tool.label}
                className={styles.tool}
                onMouseDown={keepSelection}
                type="button"
                aria-label={tool.label}
                aria-pressed={tool.active === undefined || editor === null ? undefined : tool.active(editor)}
                disabled={locked}
                onClick={() => {
                  if (editor !== null) tool.run(editor);
                }}
              >
                {tool.text}
              </button>
            ))}
            <button
              className={styles.tool}
              onMouseDown={keepSelection}
              type="button"
              aria-label="Link"
              aria-pressed={editor?.isActive('link') ?? false}
              disabled={locked}
              onClick={addLink}
            >
              Link
            </button>
            <button
              className={styles.tool}
              onMouseDown={keepSelection}
              type="button"
              aria-label="Add a picture or GIF"
              disabled={locked || uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Picture / GIF'}
            </button>
            <button
              className={styles.tool}
              onMouseDown={keepSelection}
              type="button"
              aria-label="Add a YouTube video"
              disabled={locked}
              onClick={addVideo}
            >
              YouTube
            </button>
            <input
              ref={fileRef}
              className={styles.file}
              type="file"
              tabIndex={-1}
              aria-hidden="true"
              accept={ACCEPTED_RELEASE_NOTE_IMAGE_TYPES.join(',')}
              onChange={(event) => void onFile(event)}
            />
          </div>
          <EditorContent className={styles.editorContent} editor={editor} />
        </div>
        <p className={styles.hint}>
          Pictures: {ACCEPTED_RELEASE_NOTE_IMAGE_LABEL}, up to {MAX_RELEASE_NOTE_IMAGE_LABEL} each. Videos
          are added by their YouTube link.
        </p>
      </div>

      {failure === null ? null : (
        <p className={styles.failure} role="alert">
          {failure}
        </p>
      )}

      <div className={styles.formActions}>
        <button className={styles.submit} type="submit" disabled={locked || uploading}>
          {busy ? 'Saving…' : source === null ? 'Publish post' : 'Save changes'}
        </button>
        <button className={styles.action} type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
