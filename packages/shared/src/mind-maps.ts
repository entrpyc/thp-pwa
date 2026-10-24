import { RECORDINGS_PATH } from './recordings';
import { checkAnchorMs } from './scripture';

/**
 * **A recording's mind map** ([3.8.1](docs/project/prd.md)–[3.8.4](docs/project/prd.md)): the
 * teaching's concepts as a tree a member walks.
 *
 * Three decisions, taken once here so the worker, the approve path and the two screens cannot
 * disagree about what a map is:
 *
 * 1. **A strict tree, three levels deep.** The teaching is the root, its themes are the branches
 *    and the points made under each theme are the leaves. No cross-links and no free graph: a tree
 *    lays out deterministically, collapses by subtree ([3.8.3](docs/project/prd.md)) and is
 *    curated by renaming, removing and re-parenting a node ([3.8.2](docs/project/prd.md)) —
 *    which is exactly the three edits a review has. Depth and breadth are **capped**
 *    ({@link MIND_MAP_MAX_DEPTH}, {@link MIND_MAP_MAX_THEMES}, {@link MIND_MAP_MAX_POINTS}), so a
 *    map of a ninety-minute teaching still fits a phone.
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

/** Root, theme, point — and nothing under a point. */
export const MIND_MAP_MAX_DEPTH = 3;

/** The most themes a map holds under its root. */
export const MIND_MAP_MAX_THEMES = 8;

/** The most points a theme holds. */
export const MIND_MAP_MAX_POINTS = 6;

/** A node is a phrase, not a paragraph. Longer labels are cut here before anything stores them. */
export const MIND_MAP_MAX_LABEL_LENGTH = 120;

/**
 * **What the model is asked for**, loosely typed because it is read from a provider's answer.
 *
 * Themes carry `points`; the stored tree carries `children`. The two names exist because the prompt
 * reads better as "themes and points" and the tree reads better as one recursive shape; the
 * normaliser below accepts either spelling on the way in.
 */
export interface ProposedMindMap {
  readonly themes?: unknown;
}

export interface MindMapBuild {
  readonly root: MindMapNode;
  /**
   * How many proposed nodes were not kept — blank labels, a theme past the eighth, a point past
   * the sixth, anything nested under a point. A number on the run that proposed them, as the
   * dropped citations are, so a prompt going wrong is visible rather than quiet.
   */
  readonly dropped: number;
}

/**
 * **Build the stored tree from what the machine proposed**, dropping what does not fit and
 * counting it.
 *
 * Lenient on purpose: this is the worker's reading of a model's answer, and a model that wrote a
 * ninth theme has still written eight good ones. The strict reading — refuse rather than drop — is
 * {@link checkMindMapTree}, which is what an admin's corrected tree meets.
 */
export function buildMindMapTree(title: string, proposed: unknown): MindMapBuild {
  let dropped = 0;
  let next = 0;
  const id = () => `n${(next += 1)}`;

  const readNode = (value: unknown, depth: number): MindMapNode | null => {
    if (typeof value !== 'object' || value === null) {
      dropped += 1;
      return null;
    }
    const raw = value as Record<string, unknown>;
    const label = cleanLabel(raw['label']);
    if (label === '') {
      dropped += 1;
      return null;
    }
    // Anything nested under a point is counted rather than silently lost, so an over-deep answer
    // shows up on the job that produced it.
    if (depth >= MIND_MAP_MAX_DEPTH) {
      dropped += countNested(raw);
      return { id: id(), label, anchorMs: checkAnchorMs(raw['anchorMs']), children: [] };
    }
    return { id: id(), label, anchorMs: checkAnchorMs(raw['anchorMs']), children: readChildren(raw, depth) };
  };

  const countNested = (raw: Record<string, unknown>): number => {
    const listed = raw['points'] ?? raw['children'];
    if (!Array.isArray(listed)) return 0;
    return listed.reduce<number>(
      (total, entry) =>
        total + 1 + (typeof entry === 'object' && entry !== null ? countNested(entry as Record<string, unknown>) : 0),
      0,
    );
  };

  const readChildren = (raw: Record<string, unknown>, depth: number): MindMapNode[] => {
    const listed = raw['points'] ?? raw['children'];
    if (!Array.isArray(listed)) return [];
    const cap = depth === 1 ? MIND_MAP_MAX_THEMES : MIND_MAP_MAX_POINTS;
    const kept: MindMapNode[] = [];
    for (const entry of listed) {
      if (kept.length >= cap) {
        dropped += 1;
        continue;
      }
      const node = readNode(entry, depth + 1);
      if (node !== null) kept.push(node);
    }
    return kept;
  };

  const themes =
    typeof proposed === 'object' && proposed !== null
      ? (proposed as ProposedMindMap).themes
      : undefined;

  const root: MindMapNode = {
    id: id(),
    label: cleanLabel(title) || 'This teaching',
    anchorMs: null,
    children: readChildren({ children: themes }, 1),
  };
  return { root, dropped };
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
        message: `“${label}” has points under it, and a map is only ${MIND_MAP_MAX_DEPTH} levels deep.`,
      };
    }
    const cap = depth === 1 ? MIND_MAP_MAX_THEMES : MIND_MAP_MAX_POINTS;
    if (listed.length > cap) {
      return {
        message:
          depth === 1
            ? `A map holds at most ${MIND_MAP_MAX_THEMES} themes; this one has ${listed.length}.`
            : `“${label}” holds ${listed.length} points, and a theme holds at most ${MIND_MAP_MAX_POINTS}.`,
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
