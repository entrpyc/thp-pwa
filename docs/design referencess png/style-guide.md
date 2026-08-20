# Teaching Hub — UI Style Guide

Dark, calm, one purple accent. Surfaces separate by **tone and hairline borders**, not shadows or hard lines. Everything is rounded and outlined on a near-black navy.

> Hex values are sampled from the reference screenshots, so treat them as a starting palette to lock in, not gospel.

---

## Design principles

1. **One accent.** Purple carries every primary action, active state, and link. Don't introduce a second general accent — it dilutes the signal.
2. **Tone over borders over shadows.** Lift a panel by making it one step lighter than the page. Use a faint border only when tone isn't enough. Avoid drop shadows.
3. **Rounded and outlined.** Circular icon buttons, pill tabs, rounded cards. Transparent fills with thin outlines are the default; solid fills are reserved for the one primary action on screen.
4. **Airy.** Generous padding inside cards, clear gaps between them, big breathing room around titles.
5. **Category color is meaning, not decoration.** Green = notes. If you add more category colors, each must map to exactly one concept.

---

## Color

### Backgrounds & surfaces

| Token | Hex | Use |
|---|---|---|
| `--color-bg` | `#01101F` | Page base (near-black navy) |
| `--color-bg-deep` | `#00162B` | Alt page base on media/detail screens |
| `--color-surface` | `#0A1A2C` | Cards, rows, player container |
| `--color-surface-raised` | `#0F2438` | Inner panels, hovered rows, inputs |

Backgrounds vary a little screen to screen (`#00162B`–`#040D1C`). Pick one canonical base and stick to it; let surfaces sit ~8–12 lightness steps above it.

### Accent — purple

| Token | Hex | Use |
|---|---|---|
| `--color-primary` | `#6F2BDD` | Filled play/pause, primary action |
| `--color-primary-strong` | `#7030CE` | Links, active tab, current breadcrumb |
| `--color-primary-icon` | `#8B5CF6` | Icon strokes (toolbar, search, decorative) |
| `--color-primary-soft` | `rgba(111,43,221,0.12)` | Active tab fill, focus glow |

### Category — green (notes only)

| Token | Hex | Use |
|---|---|---|
| `--color-notes` | `#22C55E` | Notes icon stroke |
| `--color-notes-bg` | `#03352B` | Notes icon tile fill |

### Text

| Token | Hex | Use |
|---|---|---|
| `--color-text` | `#FCFCFC` | Titles, primary text |
| `--color-text-muted` | `#8A97AC` | Body copy, one-line descriptions |
| `--color-text-dim` | `#6B7A90` | Metadata, timestamps, placeholders |

### Border

| Token | Value | Use |
|---|---|---|
| `--color-border` | `rgba(255,255,255,0.08)` | Card/row outlines, dividers |
| `--color-border-strong` | `rgba(255,255,255,0.14)` | Emphasized outline (e.g. active pill) |

Row dividers inside a list use `--color-border` as a 1px hairline rather than a gap.

---

## Typography

Clean neutral sans throughout (Inter or equivalent). The decorative serif on series thumbnails is baked into the artwork — not a UI font.

| Role | Size | Weight | Color |
|---|---|---|---|
| Page title | 28–34px | 700 | `--color-text` |
| Card / row title | 16–18px | 600 | `--color-text` |
| Description | 14px | 400 | `--color-text-muted` |
| Metadata | 12–13px | 400 | `--color-text-dim` |
| Link | 14px | 500 | `--color-primary-strong` |

Line-height ~1.4 for body, ~1.2 for titles. Descriptions are truncated to one line in list rows, allowed to wrap in detail views.

```css
--font-sans: "Inter", system-ui, -apple-system, sans-serif;
--fs-title: 2rem;      /* 32px */
--fs-card-title: 1.125rem;
--fs-body: 0.875rem;
--fs-meta: 0.8125rem;
```

---

## Spacing

4px base scale.

| Token | px |
|---|---|
| `--space-1` | 4 |
| `--space-2` | 8 |
| `--space-3` | 12 |
| `--space-4` | 16 |
| `--space-5` | 20 |
| `--space-6` | 24 |
| `--space-8` | 32 |

**Applied defaults**

- Card inner padding: `--space-4` to `--space-5` (16–20)
- Gap between cards: `--space-3` to `--space-4` (12–16)
- Gap between sections: `--space-6` to `--space-8` (24–32)
- Outer viewport margin: `--space-4` to `--space-5` (16–20)

---

## Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 8px | Small tiles, inputs |
| `--radius-md` | 12px | Cards, rows |
| `--radius-lg` | 16px | Large panels, player, hero cards |
| `--radius-pill` | 999px | Tabs, search input, caption bar |
| `--radius-circle` | 50% | Icon buttons, play button, avatars |

---

## Components

### Card / list row

Dark surface fill, 1px `--color-border`, `--radius-md`, `--space-4`/`--space-5` padding. No shadow.

```css
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-5);
}
```

List rows are the same but taller than wide, divided internally by a hairline (`border-bottom: 1px solid var(--color-border)`) instead of gaps.

### Buttons

Three shapes, one accent:

**Primary (filled circle)** — the single most important action per screen (play/pause).
```css
.btn-primary {
  background: var(--color-primary);
  color: #fff;
  border-radius: var(--radius-circle);
  border: none;
}
```

**Icon (outlined circle)** — secondary controls (±10s, "···").
```css
.btn-icon {
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-circle);
  color: var(--color-primary-icon);
}
```

**Tab (pill)** — Chapter / Scripture / Notes / Transcript / Mindmap.
```css
.tab            { background: transparent; border: 1px solid var(--color-border); border-radius: var(--radius-pill); color: var(--color-text-muted); }
.tab[aria-selected="true"] { border-color: var(--color-primary-strong); background: var(--color-primary-soft); color: var(--color-text); }
```

### Player

Rounded (`--radius-lg`) dark container. Circular controls, one filled purple center button. Progress bar is thin with a purple filled portion, tick marks along the track, and a round thumb.

```css
.progress__fill  { background: var(--color-primary); height: 4px; border-radius: 999px; }
.progress__thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--color-primary); }
```

Subtitle caption is its own floating pill above the controls (`--radius-pill`, surface fill, muted text, trailing `×`).

### Search input

Full-width pill. Magnifier icon left, placeholder in `--color-text-dim`.

```css
.search {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-4);
  color: var(--color-text);
}
```

### Breadcrumb bar

Single dark rounded bar. Home icon → chevron `>` separators → current item in `--color-primary-strong`. Search + menu icons boxed on the right.

### Side toolbar

Floating rounded-rectangle strip docked to the right edge, evenly spaced purple icon buttons (`--color-primary-icon` strokes).

---

## Quick token block

```css
:root {
  /* backgrounds */
  --color-bg: #01101F;
  --color-bg-deep: #00162B;
  --color-surface: #0A1A2C;
  --color-surface-raised: #0F2438;

  /* accent */
  --color-primary: #6F2BDD;
  --color-primary-strong: #7030CE;
  --color-primary-icon: #8B5CF6;
  --color-primary-soft: rgba(111,43,221,0.12);

  /* category */
  --color-notes: #22C55E;
  --color-notes-bg: #03352B;

  /* text */
  --color-text: #FCFCFC;
  --color-text-muted: #8A97AC;
  --color-text-dim: #6B7A90;

  /* border */
  --color-border: rgba(255,255,255,0.08);
  --color-border-strong: rgba(255,255,255,0.14);

  /* radius */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-pill: 999px;

  /* spacing (4px base) */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px;

  /* type */
  --font-sans: "Inter", system-ui, -apple-system, sans-serif;
  --fs-title: 2rem;
  --fs-card-title: 1.125rem;
  --fs-body: 0.875rem;
  --fs-meta: 0.8125rem;
}
```
