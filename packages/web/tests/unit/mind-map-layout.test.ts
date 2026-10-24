import { describe, expect, it } from 'vitest';
import type { MindMapNode } from '@thp/shared';
import {
  CANVAS_PADDING,
  COLUMN_GAP,
  COLUMN_WIDTHS,
  ROW_GAP,
  estimateNodeHeight,
  layoutMindMap,
} from '@/client/mind-map/layout';

/**
 * **The layout is a pure function of the tree and what is expanded** ([3.8.3](docs/project/prd.md)).
 *
 * Asserted as geometry rather than as a snapshot: columns by depth, children stacked without
 * overlap, a parent centred on its children, collapsed nodes drawn as leaves with a count. A
 * snapshot would pass by matching itself; these are the properties the canvas depends on.
 */

const point = (id: string, label: string, anchorMs: number | null = null): MindMapNode => ({
  id,
  label,
  anchorMs,
  children: [],
});

const TREE: MindMapNode = {
  id: 'root',
  label: 'The teaching',
  anchorMs: null,
  children: [
    { id: 't1', label: 'Grace', anchorMs: 4000, children: [point('p1', 'Unearned', 4000), point('p2', 'Given')] },
    { id: 't2', label: 'Law', anchorMs: null, children: [point('p3', 'Written')] },
    point('t3', 'Hope'),
  ],
};

const byId = (nodes: ReturnType<typeof layoutMindMap>['nodes']) =>
  new Map(nodes.map((one) => [one.id, one]));

describe('what is drawn', () => {
  it('draws the root and its themes with the points folded away, and counts what is hidden', () => {
    const layout = layoutMindMap(TREE, new Set(['root']));
    const ids = layout.nodes.map((one) => one.id).sort();

    expect(ids).toEqual(['root', 't1', 't2', 't3']);
    const nodes = byId(layout.nodes);
    expect(nodes.get('t1')?.expanded).toBe(false);
    expect(nodes.get('t1')?.hidden).toBe(2);
    expect(nodes.get('t2')?.hidden).toBe(1);
    // A leaf is never "collapsed": there is nothing under it to fold.
    expect(nodes.get('t3')?.expanded).toBe(true);
    expect(nodes.get('t3')?.hidden).toBe(0);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual([
      'root>t1',
      'root>t2',
      'root>t3',
    ]);
  });

  it('draws a theme’s points once it is expanded, with an edge to each', () => {
    const layout = layoutMindMap(TREE, new Set(['root', 't1']));
    expect(layout.nodes.map((one) => one.id)).toContain('p1');
    expect(layout.nodes.map((one) => one.id)).toContain('p2');
    expect(layout.nodes.map((one) => one.id)).not.toContain('p3');
    expect(layout.edges.some((edge) => edge.from === 't1' && edge.to === 'p1')).toBe(true);
    expect(layout.edges.every((edge) => edge.d.startsWith('M '))).toBe(true);
  });

  it('draws nothing but the root when the root is collapsed', () => {
    const layout = layoutMindMap(TREE, new Set());
    expect(layout.nodes.map((one) => one.id)).toEqual(['root']);
    expect(layout.nodes[0]?.hidden).toBe(6);
    expect(layout.edges).toEqual([]);
  });
});

describe('where it goes', () => {
  it('puts each depth in its own column, left to right', () => {
    const nodes = byId(layoutMindMap(TREE, new Set(['root', 't1', 't2'])).nodes);
    const root = nodes.get('root')!;
    const theme = nodes.get('t1')!;
    const pointNode = nodes.get('p1')!;

    expect(root.x).toBe(CANVAS_PADDING);
    expect(root.width).toBe(COLUMN_WIDTHS[0]);
    expect(theme.x).toBe(root.x + root.width + COLUMN_GAP);
    expect(theme.width).toBe(COLUMN_WIDTHS[1]);
    expect(pointNode.x).toBe(theme.x + theme.width + COLUMN_GAP);
    expect(pointNode.width).toBe(COLUMN_WIDTHS[2]);
  });

  it('stacks siblings without overlap, in order, a row gap apart', () => {
    const nodes = byId(layoutMindMap(TREE, new Set(['root', 't1', 't2'])).nodes);
    const column = ['t1', 't2', 't3'].map((id) => nodes.get(id)!);
    for (let at = 1; at < column.length; at += 1) {
      const above = column[at - 1]!;
      const below = column[at]!;
      expect(below.y).toBeGreaterThanOrEqual(above.y + above.height + ROW_GAP);
    }
    const points = ['p1', 'p2'].map((id) => nodes.get(id)!);
    expect(points[1]!.y).toBeGreaterThanOrEqual(points[0]!.y + points[0]!.height + ROW_GAP);
  });

  it('centres a parent on the span of its children', () => {
    const nodes = byId(layoutMindMap(TREE, new Set(['root', 't1'])).nodes);
    const theme = nodes.get('t1')!;
    const first = nodes.get('p1')!;
    const last = nodes.get('p2')!;
    const spanMiddle = (first.y + last.y + last.height) / 2;
    expect(theme.y + theme.height / 2).toBeCloseTo(spanMiddle, 5);

    // The root centres on the span of everything under it — the expanded theme's points included,
    // since they are what the first subtree occupies — not on the theme boxes alone.
    const root = nodes.get('root')!;
    const below = [...nodes.values()].filter((one) => one.id !== 'root');
    const spanTop = Math.min(...below.map((one) => one.y));
    const spanBottom = Math.max(...below.map((one) => one.y + one.height));
    expect(root.y + root.height / 2).toBeCloseTo((spanTop + spanBottom) / 2, 5);
  });

  it('centres children on a parent that is the taller', () => {
    const tall: MindMapNode = {
      id: 'r',
      label: 'A very long title for a teaching that wraps onto several lines in its box, which is the case this covers',
      anchorMs: null,
      children: [point('a', 'Short')],
    };
    const nodes = byId(layoutMindMap(tall, new Set(['r'])).nodes);
    const parent = nodes.get('r')!;
    const child = nodes.get('a')!;
    expect(parent.height).toBeGreaterThan(child.height);
    expect(parent.y).toBe(CANVAS_PADDING);
    expect(child.y + child.height / 2).toBeCloseTo(parent.y + parent.height / 2, 5);
  });

  it('sizes the picture to its outermost boxes plus the padding', () => {
    const layout = layoutMindMap(TREE, new Set(['root', 't1']));
    const right = Math.max(...layout.nodes.map((one) => one.x + one.width));
    const bottom = Math.max(...layout.nodes.map((one) => one.y + one.height));
    expect(layout.width).toBe(right + CANVAS_PADDING);
    expect(layout.height).toBe(bottom + CANVAS_PADDING);
  });

  it('gives every box the extra height an editable canvas asks for', () => {
    const plain = byId(layoutMindMap(TREE, new Set(['root'])).nodes);
    const edited = byId(layoutMindMap(TREE, new Set(['root']), { extraHeight: 30 }).nodes);
    for (const id of ['root', 't1', 't3']) {
      expect(edited.get(id)!.height).toBe(plain.get(id)!.height + 30);
    }
  });
});

describe('how tall a box is', () => {
  it('grows with the words, and by a chip for a node that names a moment', () => {
    const width = COLUMN_WIDTHS[1];
    const one = estimateNodeHeight('Grace', width, false);
    const wrapped = estimateNodeHeight('A label long enough that it has to wrap onto a second line', width, false);
    expect(wrapped).toBeGreaterThan(one);
    expect(estimateNodeHeight('Grace', width, true)).toBeGreaterThan(one);
    // Deterministic: the same words are the same height every time.
    expect(estimateNodeHeight('Grace', width, false)).toBe(one);
  });
});
