'use client';

import type { ChapterView } from '@thp/shared';
import styles from '../../screens.module.css';

/**
 * **The teaching's reflection questions, as a list to read.**
 *
 * Every chapter carries one self-reflection question, written for the Flow Tracker
 * ([3.14.4](docs/project/prd.md)). The Flow Tracker asks them one at a time and waits for an
 * answer; this card shows them all at once and asks for nothing — a member who has just heard the
 * teaching reads down the list the way they read the summary, which is why the card takes the
 * summary's shape rather than a form's. It is the whole of the `Reflection` tab on the recording
 * page, with every chapter's question, and on a chapter page, with that chapter's alone.
 *
 * The questions come in **chapter order**, and a chapter whose question has not been written yet
 * is simply skipped: the list is what there is to reflect on, not a row per chapter with holes in
 * it. The tab is not drawn at all when there is no question yet — the caller decides that off the
 * same list, as it does for `Chapters`.
 */
export function questionsOf(chapters: readonly ChapterView[] | null): readonly string[] {
  if (chapters === null) return [];
  return chapters.flatMap((chapter) => (chapter.question === null ? [] : [chapter.question]));
}

export function ReflectionCard({ questions }: { questions: readonly string[] }) {
  return (
    <section className={styles.card} aria-label="Reflection">
      <h2 className={styles.cardTitle}>Reflection</h2>
      <ul className={styles.reflectionList}>
        {questions.map((question, index) => (
          <li key={index} className={styles.reflectionItem}>
            {question}
          </li>
        ))}
      </ul>
    </section>
  );
}
