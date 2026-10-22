import type { ReactNode } from 'react';
import { currentActor } from '@/server/auth/current-actor';
import { BackRoute } from './back-route';
import styles from './public-document.module.css';

/** One titled run of prose. `body` is the paragraphs, lists and links under the heading. */
export interface PublicDocumentSection {
  readonly heading: string;
  readonly body: ReactNode;
}

export interface PublicDocumentProps {
  readonly title: string;
  /** The calendar day the text last changed, as `YYYY-MM-DD`. */
  readonly updatedOn: string;
  readonly sections: readonly PublicDocumentSection[];
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `22 October 2026` — the day spelled out, because a legal page is read rather than scanned. */
const UPDATED_ON = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * **A long-form text page on the public surface** — a privacy policy, the terms, a support page,
 * an account-deletion request. One shape for all of them, so the pages that need one do not each
 * decide what a heading weighs or where the way out goes.
 *
 * A server component, because the one thing it decides depends on the session: **where "back"
 * leads when there is nowhere to go back to.** A reader with a session is in the app and returns to
 * it; a reader without one is at the door and returns to sign-in. Reading the session here rather
 * than taking it as a prop is what keeps a page from forgetting to — the member layout makes the
 * same choice for the same reason. It reads the session; it never requires one, which is what
 * being under `(public)` means.
 *
 * The date is a calendar day and not an instant, formatted in UTC so the day a page names is the
 * day its author wrote, on every server and in every browser. A value that is not a calendar day is
 * refused at render rather than shown as "Invalid Date" under a legal heading — it is a literal in
 * a page's source, so refusing it is refusing a typo, at the moment the typo is made.
 */
export async function PublicDocument({ title, updatedOn, sections }: PublicDocumentProps) {
  if (!CALENDAR_DAY.test(updatedOn)) {
    throw new Error(`PublicDocument: updatedOn must be a YYYY-MM-DD day, got "${updatedOn}"`);
  }
  const signedIn = (await currentActor()) !== null;

  return (
    <article className={styles.article}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.updated}>
          Last updated <time dateTime={updatedOn}>{UPDATED_ON.format(new Date(updatedOn))}</time>
        </p>
      </div>

      {sections.map((section) => (
        <section className={styles.section} key={section.heading}>
          <h2 className={styles.heading}>{section.heading}</h2>
          <div className={styles.body}>{section.body}</div>
        </section>
      ))}

      <BackRoute className={styles.link} fallbackHref={signedIn ? '/' : '/sign-in'}>
        Back
      </BackRoute>
    </article>
  );
}
