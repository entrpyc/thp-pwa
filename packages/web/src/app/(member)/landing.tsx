'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MEMBER_SERIES_PAGE_PATH,
  RESUME_PATH,
  formatTimecode,
  recordingPagePath,
  type ResumePayload,
  type ResumeView,
} from '@thp/shared';
import { apiFetch } from '@/client/api-client';
import styles from './screens.module.css';

/**
 * **The member landing** — `pages/dashboard.png`.
 *
 * The reference has three cards. One ships:
 *
 * - **Resume recording** — Story 4's, and the marquee behaviour behind it.
 * - **View all series**. Story 4 shipped this row pointing at the library, because series did not
 *   exist yet; Story 6 gives it the destination the reference draws. *All recordings* did not
 *   disappear with it — it is an entry in the menu, beside *All series*, which is where
 *   `top-navigation/menu-opened.png` puts both.
 * - **My notes** — [§3.12](docs/project/prd.md) is deferred whole, so the card is **dropped**
 *   rather than rendered empty. An empty card is a promise; a missing one is a screen that will
 *   grow.
 *
 * **Elapsed only.** The reference prints `01:23 / 02:30`, and the second half of that is a number
 * this epic has nowhere: nothing inspects the media and `recording` has no duration column. So the
 * card says where the member got to, and the player learns the total from the element.
 *
 * Pressing the card goes to the teaching. It deliberately does **not** start playing from here — a
 * member who tapped a card on a phone in company has not asked for sound, and the recording page
 * restores the same position anyway.
 */
export function Landing() {
  const [resume, setResume] = useState<ResumeView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void apiFetch<ResumePayload>(RESUME_PATH, { credentials: 'include' })
      .then((payload) => setResume(payload.resume))
      .catch(() => setResume(null))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <>
      {/*
        The reference carries no page title — the breadcrumb bar is the heading a member reads. A
        screen still needs one h1, so it is here and it is not painted.
      */}
      <h1 className={styles.hiddenTitle}>Dashboard</h1>

      {loaded && resume !== null ? (
        <section className={styles.card} aria-label="Resume recording">
          <h2 className={styles.cardTitle}>Resume recording</h2>
          <Link className={styles.resume} href={recordingPagePath(resume.recordingId)}>
            <span className={styles.resumePlay} aria-hidden="true">
              ▶
            </span>
            <span className={styles.resumeText}>
              <span className={styles.resumeName}>{resume.title}</span>
              {resume.description === null ? null : (
                <span className={styles.resumeDescription}>{resume.description}</span>
              )}
              <span className={styles.resumeAt}>
                Resume at {formatTimecode(resume.positionMs)}
              </span>
            </span>
          </Link>
        </section>
      ) : null}

      <Link className={styles.wayIn} href={MEMBER_SERIES_PAGE_PATH}>
        <span className={styles.wayInLabel}>View all series</span>
        <span className={styles.wayInArrow} aria-hidden="true">
          →
        </span>
      </Link>
    </>
  );
}
