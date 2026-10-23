import type { SosUrgency } from '@thp/shared';
import styles from './sos.module.css';

/**
 * The urgency's colour as a mark. Always printed beside the word for it, never alone — the colour
 * is a second channel for the same fact, not the fact ([3.16.1](docs/project/prd.md)).
 */
export function UrgencyDot({ urgency }: { urgency: SosUrgency }) {
  return <span className={`${styles.dot} ${styles[urgency]}`} aria-hidden="true" />;
}
