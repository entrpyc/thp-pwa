import { RECORDINGS_PATH } from './recordings';
import { checkAnchorMs } from './scripture';

/**
 * **A recording's mind map** ([3.8.1](docs/project/prd.md)–[3.8.4](docs/project/prd.md)): the
 * teaching's concepts as a tree a member walks.
 *
 * Three decisions, taken once here so the worker, the approve path and the two screens cannot
 * disagree about what a map is:
 *
 * 1. **A strict tree, four levels deep.** The teaching is the root, its chapters are the first
 *    branches, each chapter splits into the themes spoken in it, and the concepts made under each
 *    theme are the leaves. A teaching too short to hold chapters ([3.22.4](docs/project/prd.md))
 *    skips the chapter level: its themes hang off the root and the map is three levels deep. No
 *    cross-links and no free graph: a tree lays out deterministically, collapses by subtree
 *    ([3.8.3](docs/project/prd.md)) and is curated by renaming, removing and re-parenting a node
 *    ([3.8.2](docs/project/prd.md)) — which is exactly the three edits a review has. Depth and
 *    breadth are **capped** ({@link MIND_MAP_MAX_DEPTH}, {@link MIND_MAP_MAX_CHAPTERS},
 *    {@link MIND_MAP_MAX_THEMES}, {@link MIND_MAP_MAX_POINTS}), so a map of a ninety-minute
 *    teaching still fits a phone.
 * 2. **A node that names a moment carries its offset** ([3.8.4](docs/project/prd.md)). `anchorMs`
 *    is the same kind of value a scripture reference's anchor is, read by the same check: a
 *    non-negative integer, or `null` for a concept that was not placed.
 * 3. **It is a review kind, not a table of its own state.** The machine proposes a tree, an admin
 *    curates it in the review form, and approving writes the one `mind_map` row a member reads.
 *    Visibility rides the recording's publication, as scripture's does.
 */

/** One node of a stored map. The shape the review form renders, sends back, and a member reads. */
export interface MindMapNode {
  /**
   * Stable within one map. Assigned when the tree is built ({@link buildMindMapTree}), kept across
   * edits so a React key and an "expanded" set survive a rename, and never meaningful outside the
   * map it is in.
   */
  readonly id: string;
  readonly label: string;
  /** Where in the teaching this concept is spoken, or `null` for one that was not placed. */
  readonly anchorMs: number | null;
  readonly children: readonly MindMapNode[];
}

/** Root, chapter, theme, concept — and nothing under a concept. */
export const MIND_MAP_MAX_DEPTH = 4;

/**
 * The most chapters a map holds under its root. Chapters run fifteen to twenty-five minutes
 * ([3.22.4](docs/project/prd.md)), so this is a four-hour teaching — far past anything recorded.
 */
export const MIND_MAP_MAX_CHAPTERS = 16;

/** The most themes a chapter holds — or the root, for a teaching with no chapters. */
export const MIND_MAP_MAX_THEMES = 8;

/** The most concepts a theme holds. */
export const MIND_MAP_MAX_POINTS = 6;

/**
 * How many children a node at this depth may hold, by depth alone: the root holds chapters, a
 * chapter holds themes, a theme holds concepts, a concept holds nothing. The strict check and the
 * review form's edits read the same table, so neither can build a tree the other refuses.
 *
 * Lenient by one level on a map with no chapters — its themes sit at the root, under the chapter
 * cap — which is the price of one rule for both shapes, and a generous cap on a short teaching is
 * not a map anybody has to scroll.
 */
export function mindMapChildCap(depth: number): number {
  if (depth >= MIND_MAP_MAX_DEPTH) return 0;
  if (depth === 1) return MIND_MAP_MAX_CHAPTERS;
  if (depth === 2) return MIND_MAP_MAX_THEMES;
  return MIND_MAP_MAX_POINTS;
}

/** A node is a phrase, not a paragraph. Longer labels are cut here before anything stores them. */
export const MIND_MAP_MAX_LABEL_LENGTH = 120;

/**
 * **What the model is asked for**, loosely typed because it is read from a provider's answer.
 *
 * Themes carry `points`; the stored tree carries `children`. The two names exist because the prompt
 * reads better as "themes and points" and the tree reads better as one recursive shape; the
 * normaliser below accepts either spelling on the way in.
 *
 * One of these is asked for **per chapter**: the model reads one chapter's lines and answers with
 * the themes spoken in them. The chapter level of the tree is never the model's to propose — it is
 * the chapter list the teaching already has ([3.22.1](docs/project/prd.md)).
 */
export interface ProposedMindMap {
  readonly themes?: unknown;
}

/** One chapter of a teaching, with what the model proposed for its stretch of the transcript. */
export interface ProposedChapterMap {
  readonly label: string;
  /** Where the chapter begins — the node's anchor, so a chapter box goes to its own start. */
  readonly anchorMs: number | null;
  readonly proposed: unknown;
}

export interface MindMapBuild {
  readonly root: MindMapNode;
  /**
   * How many proposed nodes were not kept — blank labels, a theme past the eighth, a concept past
   * the sixth, anything nested under a concept. A number on the run that proposed them, as the
   * dropped citations are, so a prompt going wrong is visible rather than quiet.
   */
  readonly dropped: number;
}

/** The lenient readers share one id counter and one count of what was dropped. */
interface Builder {
  readonly id: () => string;
  readonly drop: (count: number) => void;
  readonly dropped: () => number;
}

function builder(): Builder {
  let dropped = 0;
  let next = 0;
  return {
    id: () => `n${(next += 1)}`,
    drop: (count) => {
      dropped += count;
    },
    dropped: () => dropped,
  };
}

/**
 * **Read one proposal's themes** — each with its concepts, and nothing under a concept — into the
 * nodes that sit under one parent. The parent is the root on a map with no chapters and a chapter
 * node otherwise; the rules are the same under both.
 */
function readThemes(proposed: unknown, build: Builder): MindMapNode[] {
  const themes =
    typeof proposed === 'object' && proposed !== null
      ? (proposed as ProposedMindMap).themes
      : undefined;
  return readList(themes, MIND_MAP_MAX_THEMES, build, (theme) =>
    readList(theme['points'] ?? theme['children'], MIND_MAP_MAX_POINTS, build, (point) => {
      // Anything nested under a concept is counted rather than silently lost, so an over-deep
      // answer shows up on the job that produced it.
      build.drop(countNested(point));
      return [];
    }),
  );
}

function readList(
  listed: unknown,
  cap: number,
  build: Builder,
  childrenOf: (raw: Record<string, unknown>) => MindMapNode[],
): MindMapNode[] {
  if (!Array.isArray(listed)) return [];
  const kept: MindMapNode[] = [];
  for (const entry of listed) {
    if (kept.length >= cap || typeof entry !== 'object' || entry === null) {
      build.drop(1);
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const label = cleanLabel(raw['label']);
    if (label === '') {
      build.drop(1);
      continue;
    }
    kept.push({
      id: build.id(),
      label,
      anchorMs: checkAnchorMs(raw['anchorMs']),
      children: childrenOf(raw),
    });
  }
  return kept;
}

function countNested(raw: Record<string, unknown>): number {
  const listed = raw['points'] ?? raw['children'];
  if (!Array.isArray(listed)) return 0;
  return listed.reduce<number>(
    (total, entry) =>
      total + 1 + (typeof entry === 'object' && entry !== null ? countNested(entry as Record<string, unknown>) : 0),
    0,
  );
}

/**
 * **Build the stored tree from what the machine proposed for a teaching with no chapters**,
 * dropping what does not fit and counting it: the title as root, themes under it, concepts under
 * them.
 *
 * Lenient on purpose: this is the worker's reading of a model's answer, and a model that wrote a
 * ninth theme has still written eight good ones. The strict reading — refuse rather than drop — is
 * {@link checkMindMapTree}, which is what an admin's corrected tree meets.
 */
export function buildMindMapTree(title: string, proposed: unknown): MindMapBuild {
  const build = builder();
  const root: MindMapNode = {
    id: build.id(),
    label: cleanLabel(title) || 'This teaching',
    anchorMs: null,
    children: readThemes(proposed, build),
  };
  return { root, dropped: build.dropped() };
}

/**
 * **Build the stored tree for a teaching with chapters**: the title as root, one node per chapter
 * in the order given, and under each the themes the model proposed from that chapter's own lines.
 *
 * The chapter nodes are the teaching's chapters and not a proposal, so none is dropped for its
 * label — a chapter with no title gets its position — and only a list past
 * {@link MIND_MAP_MAX_CHAPTERS} is cut, which no real teaching reaches. Everything under a chapter
 * is read exactly as {@link buildMindMapTree} reads a proposal.
 */
export function buildChapteredMindMapTree(
  title: string,
  chapters: readonly ProposedChapterMap[],
): MindMapBuild {
  const build = builder();
  const rootId = build.id();
  const children: MindMapNode[] = [];
  chapters.forEach((chapter, index) => {
    if (children.length >= MIND_MAP_MAX_CHAPTERS) {
      // The chapter and everything that would have been read under it.
      const under = readThemes(chapter.proposed, builder());
      build.drop(1 + under.reduce((total, one) => total + countMindMapNodes(one), 0));
      return;
    }
    children.push({
      id: build.id(),
      label: cleanLabel(chapter.label) || `Chapter ${index + 1}`,
      anchorMs: checkAnchorMs(chapter.anchorMs),
      children: readThemes(chapter.proposed, build),
    });
  });
  const root: MindMapNode = {
    id: rootId,
    label: cleanLabel(title) || 'This teaching',
    anchorMs: null,
    children,
  };
  return { root, dropped: build.dropped() };
}

function cleanLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MIND_MAP_MAX_LABEL_LENGTH);
}

export interface MindMapProblem {
  readonly message: string;
}

export type MindMapCheck =
  | { readonly ok: true; readonly root: MindMapNode }
  | { readonly ok: false; readonly problem: MindMapProblem };

/**
 * **Read a tree strictly** — the approve path's question of what an admin sent back, and the
 * reader of a stored row.
 *
 * Every refusal is a sentence the form can show. Nothing is dropped and nothing is repaired: an
 * admin's list of nine themes is refused as nine, because quietly keeping eight would publish a map
 * nobody approved. Labels are trimmed and ids are kept where they are strings, minted where they
 * are not — a node an admin added in the form has none the server has to trust.
 */
export function checkMindMapTree(value: unknown): MindMapCheck {
  const seen = new Set<string>();
  let minted = 0;

  const read = (node: unknown, depth: number, where: string): MindMapNode | MindMapProblem => {
    if (typeof node !== 'object' || node === null) {
      return { message: `${where} is not a node.` };
    }
    const raw = node as Record<string, unknown>;
    const label = cleanLabel(raw['label']);
    if (label === '') return { message: `${where} has no label. Give it a few words or remove it.` };

    const anchor = raw['anchorMs'];
    if (anchor !== null && anchor !== undefined && checkAnchorMs(anchor) === null) {
      return { message: `${where} points at a moment that is not in the recording.` };
    }

    const listed = raw['children'] ?? [];
    if (!Array.isArray(listed)) return { message: `${where} has children that are not a list.` };
    if (depth >= MIND_MAP_MAX_DEPTH && listed.length > 0) {
      return {
        message: `“${label}” has nodes under it, and a map is only ${MIND_MAP_MAX_DEPTH} levels deep.`,
      };
    }
    const cap = mindMapChildCap(depth);
    if (listed.length > cap) {
      return {
        message:
          depth === 1
            ? `A map holds at most ${cap} branches under its root; this one has ${listed.length}.`
            : `“${label}” holds ${listed.length} nodes, and a node at this level holds at most ${cap}.`,
      };
    }

    const children: MindMapNode[] = [];
    for (const [index, child] of listed.entries()) {
      const result = read(child, depth + 1, `Node ${index + 1} under “${label}”`);
      if ('message' in result) return result;
      children.push(result);
    }

    let id = typeof raw['id'] === 'string' && raw['id'].trim() !== '' ? raw['id'].trim() : '';
    if (id === '' || seen.has(id)) id = mint();
    seen.add(id);
    return { id, label, anchorMs: checkAnchorMs(anchor), children };
  };

  const mint = (): string => {
    let candidate: string;
    do {
      minted += 1;
      candidate = `a${minted}`;
    } while (seen.has(candidate));
    return candidate;
  };

  const result = read(value, 1, 'The root');
  return 'message' in result ? { ok: false, problem: result } : { ok: true, root: result };
}

/** Whether a stored value reads as a tree at all. The lenient reader of a `jsonb` column. */
export function isMindMapNode(value: unknown): value is MindMapNode {
  return checkMindMapTree(value).ok;
}

/** How many nodes a tree holds, the root included. */
export function countMindMapNodes(node: MindMapNode): number {
  return 1 + node.children.reduce((total, child) => total + countMindMapNodes(child), 0);
}

/**
 * Whether two trees say the same thing — same labels, same moments, same shape — **ignoring ids**.
 *
 * Ids are bookkeeping; an admin who renamed nothing and moved nothing has edited nothing, however
 * the form happened to key the rows.
 */
export function mindMapsEqual(a: MindMapNode, b: MindMapNode): boolean {
  if (a.label !== b.label || a.anchorMs !== b.anchorMs) return false;
  if (a.children.length !== b.children.length) return false;
  return a.children.every((child, index) => {
    const other = b.children[index];
    return other !== undefined && mindMapsEqual(child, other);
  });
}

/** The map as a member reads it. */
export interface MindMapView {
  readonly root: MindMapNode;
  /** Whether an admin changed the machine's tree before approving it ([4.17.5](docs/project/prd.md)). */
  readonly editedByAdmin: boolean;
  readonly updatedAt: string;
}

/** This teaching's published mind map, under the API prefix. */
export function recordingMindMapPath(recordingId: string): string {
  return `${RECORDINGS_PATH}/${recordingId}/mind-map`;
}

/**
 * Payload of `GET /api/v1/recordings/:id/mind-map`.
 *
 * `null` is the ordinary answer for a teaching whose map nobody has approved yet. The recording
 * payload's `hasMindMap` is what decides whether the tab is drawn, so a member rarely reads it.
 */
export interface RecordingMindMapPayload {
  readonly mindMap: MindMapView | null;
}
