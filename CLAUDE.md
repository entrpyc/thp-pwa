# Teaching Hub

## Do not build what is deferred

This project runs one epic at a time. Before
adding any infrastructure, dependency or capability, check the deliberately deferred section of the epic.

Each one has a named home in a later epic. If you believe a ticket genuinely cannot be built without
one, say so and stop — that is a scope decision for the user, not something to solve in passing.

## Finish the phase, then stop

Development follows the dev system — full-scope PRD → full-scope architecture → epic PRD → epic
architecture → implementation plan → per-ticket planning → implementation → story validation.
**Every phase ends by handing control back.** Present the work, name the open questions and
assumptions, close with one sentence saying what runs next, and stop there.

Do not roll from one phase into the next unprompted — do not start coding a ticket you just
planned, and do not plan the next ticket after validating a story. Advancing is the user's call;
auto-advancing is exactly the skimming risk the checkpoints exist to prevent.

## Where the docs live

- `docs/project/` — `prd.md`, `architecture.md`. Full scope, written once, permanent.
- `docs/epics/epic-<name>/` — one folder per epic, kept forever: `prd.md`, `architecture.md`,
  `implementation-plan.md`, and `stories/<story>/<NN>-<ticket>.md` for the ticket docs. Nothing
  moves when an epic finishes; the next epic is a new folder beside it.
- Current epic: [docs/epics/epic-core-listening/](docs/epics/epic-core-listening/).

Cross-document links are repo-root-relative with a line anchor — `[3.2.4](docs/project/prd.md#L65)`
— and are resolved by locating the heading, never guessed.

## Designing pages

**Every page or UI component must be built from its design reference.** The references live in
[docs/design referencess png/](docs/design%20referencess%20png/) as PNGs. Read the relevant PNG
before writing any markup or styles for that screen. If a reference is missing, use the style guide to design it.

Current references:

| Area                   | Files                                                                                                               |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `pages/`             | `dashboard.png`, `series-listing.png`, `series-inner.png`, `recording.png`, `player.png`, `chapter.png` |
| `top-navigation/`    | `default.png`, `menu-opened.png`, `search.png`                                                                |
| `bottom-navigation/` | `default.png`, `menu-opened.png`, `subtitles.png`                                                             |
| style guide            | docs\design referencess png\style-guide.md                                                                          |
