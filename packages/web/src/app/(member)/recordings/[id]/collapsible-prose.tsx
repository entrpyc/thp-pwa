'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../../screens.module.css';

/**
 * **A card of prose that opens.** The recording page's summary and its description, which are the
 * two blocks on the member surface with no length anybody controls — a transcript-derived summary
 * and whatever an admin typed. Left whole they push the tab strip off the screen; cut to a fixed
 * height with no way past it they are a card that hides half of what it says.
 *
 * So the block is **200px until it is asked to be more**, with the foot of it fading into the card
 * and the control to open it sitting in that fade. The fade is what says there is more text rather
 * than a paragraph that happens to end mid-sentence.
 *
 * Three things this does not do, each for a reason:
 *
 * - **It does not clamp what already fits.** The control and the fade are rendered off a
 *   measurement, not off a guess: a two-line summary is a two-line summary, and offering to expand
 *   it would be a control that does nothing.
 * - **It does not trap the member inside the open state.** The reference for this was "expand", but
 *   a description ten screens long that cannot be put away is worse than one that was never opened,
 *   so the same control closes it again.
 * - **It does not animate the height.** The content's full height is not known until it is open,
 *   and a transition to `max-height: none` does not run — a transition to a guessed height either
 *   cuts the text off or leaves a gap under it.
 */
export function CollapsibleProse({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  /*
   * Whether there is anything to open. Measured while collapsed only: open, the box is its content's
   * height and the comparison would say no every time — which would take the control away and leave
   * the member with no way back.
   */
  const measure = useCallback(() => {
    const element = bodyRef.current;
    if (element === null) return;
    // A pixel of slack: sub-pixel line heights make `scrollHeight` a hair over `clientHeight` on
    // text that fits perfectly well.
    setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, []);

  useEffect(() => {
    if (open) return;
    measure();

    // Re-measured as the column changes width — a paragraph that fits on a desktop is four lines
    // longer on a phone, and the control has to appear rather than the text being silently cut.
    const element = bodyRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, open, text]);

  return (
    <section className={styles.card} aria-label={label}>
      <h2 className={styles.cardTitle}>{label}</h2>
      <div className={`${styles.clamp}${open ? ` ${styles.clampOpen}` : ''}`} ref={bodyRef}>
        <p className={styles.prose}>{text}</p>
        {overflows && !open ? (
          <button
            className={styles.clampMore}
            type="button"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            See more
          </button>
        ) : null}
      </div>
      {overflows && open ? (
        <button
          className={styles.clampLess}
          type="button"
          aria-expanded
          onClick={() => setOpen(false)}
        >
          See less
        </button>
      ) : null}
    </section>
  );
}
