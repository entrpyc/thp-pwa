import { describe, expect, it } from 'vitest';
import {
  MIND_MAP_MAX_CHAPTERS,
  MIND_MAP_MAX_POINTS,
  MIND_MAP_MAX_THEMES,
  checkMindMapTree,
  type MindMapNode,
} from '@thp/shared';
import {
  addChild,
  canAddUnder,
  canMoveUnder,
  depthOf,
  findNode,
  moveNode,
  nextNodeId,
  removeNode,
  renameNode,
} from '@/client/mind-map/tree-edit';

/**
 * **The edits an admin makes to a draft map** ([3.8.2](docs/project/prd.md)) — rename, remove,
 * move, add — as pure functions, and the one property that matters above the rest: **nothing
 * here builds a tree the server would refuse.** Every result is run back through the strict check
 * the approve path uses.
 *
 * The tree is the four-level shape a teaching with chapters has: root, chapters, themes, concepts.
 */

const leaf = (id: string, label: string): MindMapNode => ({ id, label, anchorMs: null, children: [] });

const TREE: MindMapNode = {
  id: 'root',
  label: 'The teaching',
  anchorMs: null,
  children: [
    {
      id: 'c1',
      label: 'Opening',
      anchorMs: 0,
      children: [
        { id: 't1', label: 'Grace', anchorMs: 4000, children: [leaf('p1', 'Unearned'), leaf('p2', 'Given')] },
        { id: 't2', label: 'Law', anchorMs: null, children: [leaf('p3', 'Written')] },
      ],
    },
    { id: 'c2', label: 'Closing', anchorMs: 900_000, children: [leaf('t3', 'Hope')] },
  ],
};

const labels = (node: MindMapNode): unknown => [node.label, node.children.map(labels)];

describe('finding things', () => {
  it('finds a node and its depth, and answers null for an id the tree does not hold', () => {
    expect(findNode(TREE, 'p3')?.label).toBe('Written');
    expect(depthOf(TREE, 'root')).toBe(1);
    expect(depthOf(TREE, 'c1')).toBe(2);
    expect(depthOf(TREE, 't2')).toBe(3);
    expect(depthOf(TREE, 'p3')).toBe(4);
    expect(findNode(TREE, 'nowhere')).toBeNull();
    expect(depthOf(TREE, 'nowhere')).toBeNull();
  });
});

describe('rename and remove', () => {
  it('renames one node and leaves the tree it was given alone', () => {
    const next = renameNode(TREE, 'p1', 'Unearned, always');
    expect(findNode(next, 'p1')?.label).toBe('Unearned, always');
    expect(findNode(TREE, 'p1')?.label).toBe('Unearned');
    expect(checkMindMapTree(next).ok).toBe(true);
  });

  it('removes a node with everything under it, and never the root', () => {
    const next = removeNode(TREE, 't1');
    expect(labels(next)).toEqual([
      'The teaching',
      [
        ['Opening', [['Law', [['Written', []]]]]],
        ['Closing', [['Hope', []]]],
      ],
    ]);
    expect(removeNode(TREE, 'root')).toBe(TREE);
    expect(checkMindMapTree(next).ok).toBe(true);
  });
});

describe('add', () => {
  it('adds a concept under a theme, with an id no node holds, and opens nothing it should not', () => {
    const next = addChild(TREE, 't3', 'A new point');
    const added = findNode(next, 't3')?.children[0];
    expect(added?.label).toBe('A new point');
    expect(added?.id).toBe(nextNodeId(TREE));
    expect(added?.anchorMs).toBeNull();
    expect(checkMindMapTree(next).ok).toBe(true);
  });

  it('refuses to add under a concept, or past a cap at any level, by returning the tree unchanged', () => {
    expect(canAddUnder(TREE, 'p1')).toBe(false);
    expect(addChild(TREE, 'p1', 'Too deep')).toBe(TREE);

    let full = TREE;
    while (canAddUnder(full, 't2')) full = addChild(full, 't2', 'Another');
    expect(findNode(full, 't2')?.children).toHaveLength(MIND_MAP_MAX_POINTS);
    expect(addChild(full, 't2', 'One too many')).toBe(full);

    let themed = TREE;
    while (canAddUnder(themed, 'c2')) themed = addChild(themed, 'c2', 'Theme');
    expect(findNode(themed, 'c2')?.children).toHaveLength(MIND_MAP_MAX_THEMES);
    expect(checkMindMapTree(themed).ok).toBe(true);

    let wide = TREE;
    while (canAddUnder(wide, 'root')) wide = addChild(wide, 'root', 'Chapter');
    expect(wide.children).toHaveLength(MIND_MAP_MAX_CHAPTERS);
    expect(checkMindMapTree(wide).ok).toBe(true);
  });

  it('mints ids that skip any the tree already carries', () => {
    const taken: MindMapNode = { ...TREE, children: [...TREE.children, leaf('e1', 'Taken'), leaf('e2', 'Also')] };
    expect(nextNodeId(taken)).toBe('e3');
  });
});

describe('move', () => {
  it('moves a concept under another theme, keeping its subtree', () => {
    const next = moveNode(TREE, 'p1', 't2');
    expect(findNode(next, 't1')?.children.map((one) => one.id)).toEqual(['p2']);
    expect(findNode(next, 't2')?.children.map((one) => one.id)).toEqual(['p3', 'p1']);
    expect(checkMindMapTree(next).ok).toBe(true);
  });

  it('moves a branch only where the depth still fits', () => {
    // A theme with concepts under another chapter still fits: chapter, theme, concept.
    expect(canMoveUnder(TREE, 't1', 'c2')).toBe(true);
    expect(depthOf(moveNode(TREE, 't1', 'c2'), 'p1')).toBe(4);
    // A theme with concepts under another theme would put the concepts at a fifth level.
    expect(canMoveUnder(TREE, 't1', 't2')).toBe(false);
    expect(moveNode(TREE, 't1', 't2')).toBe(TREE);
    // A whole chapter under another chapter would put its concepts at a fifth level too.
    expect(canMoveUnder(TREE, 'c1', 'c2')).toBe(false);
    // A theme with nothing under it is a concept once it is under another theme.
    expect(canMoveUnder(TREE, 't3', 't2')).toBe(true);
    const next = moveNode(TREE, 't3', 't2');
    expect(depthOf(next, 't3')).toBe(4);
    expect(checkMindMapTree(next).ok).toBe(true);
    // And a concept can be lifted all the way to the root.
    expect(canMoveUnder(TREE, 'p1', 'root')).toBe(true);
    expect(depthOf(moveNode(TREE, 'p1', 'root'), 'p1')).toBe(2);
  });

  it('refuses the moves that make no tree: onto itself, into its own subtree, where it already is, the root', () => {
    expect(canMoveUnder(TREE, 't1', 't1')).toBe(false);
    expect(canMoveUnder(TREE, 't1', 'p1')).toBe(false);
    expect(canMoveUnder(TREE, 'c1', 't1')).toBe(false);
    expect(canMoveUnder(TREE, 'p1', 't1')).toBe(false);
    expect(canMoveUnder(TREE, 'root', 't1')).toBe(false);
    expect(moveNode(TREE, 't1', 'p1')).toBe(TREE);
  });

  it('refuses a move into a theme that is full', () => {
    let full = TREE;
    while (canAddUnder(full, 't2')) full = addChild(full, 't2', 'Another');
    expect(canMoveUnder(full, 'p1', 't2')).toBe(false);
  });
});
