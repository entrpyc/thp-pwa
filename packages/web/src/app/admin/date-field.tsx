'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import styles from './date-field.module.css';

/**
 * **A date field in the console's own clothes.**
 *
 * The native `<input type="date">` stays — it is what a keyboard types into, what a screen reader
 * names, and what a test fills — but the browser's grey calendar glyph is hidden and replaced by
 * the console's own button, which opens a month grid drawn from the token layer instead of the
 * operating system's picker. Picking a day writes the input's value and fires `onChange` with the
 * same `YYYY-MM-DD` the native control would have produced, so the form behind it cannot tell the
 * two ways in apart.
 *
 * The grid closes on a pick, on Escape, and on a press outside it, and the arrows walk the days
 * inside it: left and right by one, up and down by a week, Enter or Space to pick.
 */

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });

/** `YYYY-MM-DD` ↔ a local calendar day, without ever passing through a time zone. */
function parseDay(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const probe = new Date(year, month, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function formatDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Monday-first offset of the month's first day: 0 when the 1st is a Monday. */
function leadingBlanks(year: number, month: number): number {
  return (new Date(year, month, 1).getDay() + 6) % 7;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8.5" cy="14" r="1" fill="currentColor" />
      <circle cx="12" cy="14" r="1" fill="currentColor" />
      <circle cx="15.5" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DateField({
  id,
  name,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gridId = useId();

  const chosen = parseDay(value);
  const today = new Date();
  const [view, setView] = useState(() => ({
    year: chosen?.year ?? today.getFullYear(),
    month: chosen?.month ?? today.getMonth(),
  }));
  // The day the arrow keys stand on. Starts on the chosen day, else today, else the 1st.
  const [cursor, setCursor] = useState<number>(chosen?.day ?? today.getDate());

  function openGrid(): void {
    const start = parseDay(value);
    const base = start ?? { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() };
    setView({ year: base.year, month: base.month });
    setCursor(base.day);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && regionRef.current?.contains(target)) return;
      setOpen(false);
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus follows the cursor, so the arrows read as moving a selection rather than a hidden state.
  useEffect(() => {
    if (!open) return;
    const button = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${cursor}"]`);
    button?.focus();
  }, [open, cursor, view]);

  function pick(day: number): void {
    onChange(formatDay(view.year, view.month, day));
    setOpen(false);
  }

  function shiftMonth(by: number): void {
    const next = new Date(view.year, view.month + by, 1);
    const year = next.getFullYear();
    const month = next.getMonth();
    setView({ year, month });
    setCursor((current) => Math.min(current, daysInMonth(year, month)));
  }

  function moveCursor(by: number): void {
    const target = new Date(view.year, view.month, cursor + by);
    setView({ year: target.getFullYear(), month: target.getMonth() });
    setCursor(target.getDate());
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveCursor(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveCursor(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveCursor(-7);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveCursor(7);
        break;
      case 'PageUp':
        event.preventDefault();
        shiftMonth(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        shiftMonth(1);
        break;
      default:
    }
  }

  const blanks = leadingBlanks(view.year, view.month);
  const count = daysInMonth(view.year, view.month);
  const cells: (number | null)[] = [
    ...Array.from({ length: blanks }, () => null),
    ...Array.from({ length: count }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const isToday = (day: number): boolean =>
    view.year === today.getFullYear() && view.month === today.getMonth() && day === today.getDate();
  const isChosen = (day: number): boolean =>
    chosen !== null && chosen.year === view.year && chosen.month === view.month && chosen.day === day;

  return (
    <div className={styles.field} ref={regionRef}>
      <div className={styles.control}>
        <input
          className={styles.input}
          id={id}
          name={name}
          type="date"
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className={styles.iconButton}
          type="button"
          aria-label="Open calendar"
          aria-expanded={open}
          aria-controls={gridId}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openGrid())}
        >
          <CalendarIcon />
        </button>
      </div>

      {open ? (
        <div className={styles.popover} id={gridId} role="dialog" aria-label={`${label} calendar`}>
          <div className={styles.monthBar}>
            <button
              className={styles.monthStep}
              type="button"
              aria-label="Previous month"
              onClick={() => shiftMonth(-1)}
            >
              <Chevron direction="left" />
            </button>
            <p className={styles.monthName} aria-live="polite">
              {MONTH.format(new Date(view.year, view.month, 1))}
            </p>
            <button
              className={styles.monthStep}
              type="button"
              aria-label="Next month"
              onClick={() => shiftMonth(1)}
            >
              <Chevron direction="right" />
            </button>
          </div>

          <div className={styles.grid} role="grid" ref={gridRef} onKeyDown={onGridKeyDown}>
            <div className={styles.weekRow} role="row">
              {WEEKDAYS.map((weekday) => (
                <span className={styles.weekday} role="columnheader" key={weekday}>
                  {weekday}
                </span>
              ))}
            </div>
            {Array.from({ length: cells.length / 7 }, (_, week) => (
              <div className={styles.weekRow} role="row" key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((day, column) =>
                  day === null ? (
                    <span className={styles.blank} role="gridcell" key={`blank-${week}-${column}`} />
                  ) : (
                    <button
                      className={[
                        styles.day,
                        isChosen(day) ? styles.dayChosen : '',
                        isToday(day) ? styles.dayToday : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      type="button"
                      role="gridcell"
                      key={day}
                      data-day={day}
                      tabIndex={day === cursor ? 0 : -1}
                      aria-pressed={isChosen(day)}
                      aria-label={formatDay(view.year, view.month, day)}
                      onClick={() => pick(day)}
                    >
                      {day}
                    </button>
                  ),
                )}
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            <button
              className={styles.footerAction}
              type="button"
              onClick={() => {
                onChange(formatDay(today.getFullYear(), today.getMonth(), today.getDate()));
                setOpen(false);
              }}
            >
              Today
            </button>
            <button
              className={styles.footerAction}
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
