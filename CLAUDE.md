# Teaching Hub

## Do not build what is deferred

This project runs one vertical slice at a time. Before
adding any infrastructure, dependency or capability, check deliberately deferred section from the slice.

Each one has a named home in a later slice. If you believe a step genuinely cannot be built without
one, say so and stop — that is a scope decision for the user, not something to solve in passing.

## Finish the phase, then stop

Development follows the dev system — full-scope PRD → architecture → slice PRD → slice architecture
→ implementation plan → per-step planning → implementation → validation. **Every phase ends by
handing control back.** Present the work, name the open questions and assumptions, close with one
sentence saying what runs next, and stop there.

Do not roll from one phase into the next unprompted — do not start coding a step you just planned,
and do not plan the next step after validating one. Advancing is the user's call; auto-advancing is
exactly the skimming risk the checkpoints exist to prevent.

## Designing pages

**Every page or UI component must be built from its design reference.** The references live in
[docs/design referencess png/](docs/design%20referencess%20png/) as PNGs. Read the relevant PNG
before writing any markup or styles for that screen — do not invent a layout.

Current references:

| Area                   | Files                                                                                                               |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `pages/`             | `dashboard.png`, `series-listing.png`, `series-inner.png`, `recording.png`, `player.png`, `chapter.png` |
| `top-navigation/`    | `default.png`, `menu-opened.png`, `search.png`                                                                |
| `bottom-navigation/` | `default.png`, `menu-opened.png`, `subtitles.png`                                                             |

**If there is no reference for the screen you have been asked to build, stop and ask the user to add
one.** Do not design it yourself, do not approximate it from a neighbouring screen, and do not
proceed on the assumption that a reference will arrive later. Name the file you expected to find
(e.g. `docs/design referencess png/pages/<screen>.png`) so the user knows exactly what to drop in.
