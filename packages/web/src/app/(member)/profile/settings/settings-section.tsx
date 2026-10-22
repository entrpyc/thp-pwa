'use client';

import { useId, type ReactNode } from 'react';
import styles from '../profile.module.css';

/**
 * **One card on the settings page** — a title, an optional sentence of lead, and the controls.
 *
 * Every section on `/profile/settings` is this shape, so the page can be a list of them: the title
 * is an `<h3>` under the page's *Settings* `<h2>`, the card is a `<section>` labelled by it, and
 * what goes inside is the section's own business. A section that needs a different shape is a sign
 * it is a page of its own, not a card here.
 */
export function SettingsSection({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string | undefined;
  children: ReactNode;
}) {
  const titleId = useId();

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 className={styles.cardTitle} id={titleId}>
        {title}
      </h3>
      {lead === undefined ? null : <p className={styles.quiet}>{lead}</p>}
      {children}
    </section>
  );
}
