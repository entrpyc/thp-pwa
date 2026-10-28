import { countMindMapNodes, type MindMapNode } from '@thp/shared';

/**
 * **Where every visible node of a mind map goes** — a horizontal tree, root at the left
 * ([3.8.3](docs/project/prd.md)).
 *
 * Pure, and deliberately so: the same tree and the same set of expanded ids always produce the
 * same picture, on the server, in a test and in the browser, which is what lets the canvas be
 * plain HTML over an SVG of edges rather than a graph library. Node heights are **estimated from
 * the label** rather than measured, so the layout needs no second render; the estimate is generous
 * enough that a label a little longer than guessed wraps inside its box rather than over the next.
 *
 * Columns are fixed per depth — the root is one width, themes another, points a third — because a
 * phrase at a known width wraps predictably, and a column that resized to its longest label would
 * move every node each time one was renamed.
 */

/** Pixel width of a node at each depth: root, chapter, theme, concept. Deeper never happens. */
export const COLUMN_WIDTHS = [200, 200, 184, 224] as const;

/**
 * The fold control on the right of a box that has children: the chevron and the divider before
 * it. The label wraps inside what is left, so the estimate below has to leave this out.
 */
export const TOGGLE_WIDTH = 32;

/** Horizontal room between a node's right edge and its children's left edge. */
export const COLUMN_GAP = 44;

/** Vertical room between sibling subtrees. */
export const ROW_GAP = 10;

/** Room around the whole picture, so the outermost boxes do not touch the scroll edge. */
export const CANVAS_PADDING = 12;

/** The label's font is `--fs-body` (14px); at that size a character averages about this wide. */
const CHAR_WIDTH = 7.2;
/** Line height of a wrapped label, at `line-height: 1.3`. */
const LINE_HEIGHT = 18;
/** The box's vertical padding, both edges together (`--space-3` twice). */
const BOX_PADDING = 24;
/** The box's horizontal padding, both edges together (`--space-3` twice). */
const BOX_INSET = 24;
/** A timestamp chip under the label, with the gap above it (`--space-2`). */
const CHIP_HEIGHT = 32;

export interface LayoutOptions {
  /** Extra height every box carries — the editing controls, when the canvas is editable. */
  readonly extraHeight?: number;
}

export interface LayoutNode {
  readonly id: string;
  readonly node: MindMapNode;
  /** 1 for the root. */
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Whether this node's children are drawn. Always `true` for a node with none. */
  readonly expanded: boolean;
  /** How many nodes are folded away under a collapsed node, for the badge. */
  readonly hidden: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  /** An SVG path from the parent's right edge to the child's left edge. */
  readonly d: string;
}

export interface MindMapLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
}

export function columnWidth(depth: number): number {
  return COLUMN_WIDTHS[Math.min(Math.max(depth, 1), COLUMN_WIDTHS.length) - 1] ?? COLUMN_WIDTHS[0];
}

/**
 * A box's height, from the words in it and whether it carries a timestamp chip. `reserved` is
 * width the label cannot wrap into — the fold control, on a box that has one.
 */
export function estimateNodeHeight(
  label: string,
  width: number,
  hasAnchor: boolean,
  extra = 0,
  reserved = 0,
): number {
  const perLine = Math.max(8, Math.floor((width - BOX_INSET - reserved) / CHAR_WIDTH));
  const lines = Math.max(1, Math.ceil(label.length / perLine));
  return BOX_PADDING + lines * LINE_HEIGHT + (hasAnchor ? CHIP_HEIGHT : 0) + extra;
}

/** The left edge of every box at this depth. */
function columnLeft(depth: number): number {
  let x = CANVAS_PADDING;
  for (let at = 1; at < depth; at += 1) x += columnWidth(at) + COLUMN_GAP;
  return x;
}

/**
 * Lay the tree out.
 *
 * Children stack under one another, each subtree taking the room it needs; a parent sits at the
 * vertical middle of its children's span, or its children sit at the middle of the parent when the
 * parent is the taller. Collapsed nodes are leaves for layout and carry the count of what they
 * hide.
 */
export function layoutMindMap(
  root: MindMapNode,
  expanded: ReadonlySet<string>,
  options: LayoutOptions = {},
): MindMapLayout {
  const extra = options.extraHeight ?? 0;
  const placed: { id: string; node: MindMapNode; depth: number; x: number; y: number; width: number; height: number; expanded: boolean; hidden: number }[] = [];
  const edges: LayoutEdge[] = [];

  const place = (node: MindMapNode, depth: number, top: number): number => {
    const width = columnWidth(depth);
    const hasChildren = node.children.length > 0;
    // The root cannot be folded: it is what the map is of, and a map folded to its title is no map.
    const foldable = hasChildren && depth > 1;
    const height = estimateNodeHeight(
      node.label,
      width,
      node.anchorMs !== null,
      extra,
      foldable ? TOGGLE_WIDTH : 0,
    );
    const open = !foldable || expanded.has(node.id);
    const entry = {
      id: node.id,
      node,
      depth,
      x: columnLeft(depth),
      y: top,
      width,
      height,
      expanded: open,
      hidden: open ? 0 : countMindMapNodes(node) - 1,
    };
    const mine = placed.length;
    placed.push(entry);

    if (!open || !hasChildren) return height;

    const firstChild = placed.length;
    let cursor = top;
    for (const child of node.children) {
      cursor += place(child, depth + 1, cursor) + ROW_GAP;
      edges.push({ from: node.id, to: child.id, d: '' });
    }
    const span = cursor - ROW_GAP - top;

    if (span >= height) {
      entry.y = top + (span - height) / 2;
      return span;
    }
    // The parent is the taller: its children move down to centre on it.
    const shift = (height - span) / 2;
    for (let at = firstChild; at < placed.length; at += 1) {
      const one = placed[at];
      if (one !== undefined && at !== mine) one.y += shift;
    }
    return height;
  };

  place(root, 1, CANVAS_PADDING);

  const byId = new Map(placed.map((one) => [one.id, one]));
  const drawn = edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) return edge;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const mid = (x1 + x2) / 2;
    return { ...edge, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` };
  });

  let width = 0;
  let height = 0;
  for (const one of placed) {
    width = Math.max(width, one.x + one.width);
    height = Math.max(height, one.y + one.height);
  }

  return {
    nodes: placed.map((one) => ({ ...one })),
    edges: drawn,
    width: width + CANVAS_PADDING,
    height: height + CANVAS_PADDING,
  };
}
