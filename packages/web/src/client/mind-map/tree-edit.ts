import { MIND_MAP_MAX_DEPTH, mindMapChildCap, type MindMapNode } from '@thp/shared';

/**
 * **The three edits a curated map has** ([3.8.2](docs/project/prd.md)) — rename a node, remove it,
 * move it under another — and a fourth, adding one, because a theme the machine left empty is only
 * fixable by putting something under it.
 *
 * Pure functions over an immutable tree. Every one returns a new root and leaves the old one
 * alone, which is what lets the review form hold the machine's proposal beside the admin's version
 * and say whether they differ. Nothing here knows about React.
 *
 * The caps are the same ones the server applies ({@link MIND_MAP_MAX_DEPTH} and the breadth per
 * level, read off `mindMapChildCap`): the form refuses a move or an add the server would refuse,
 * so an admin never builds a tree the approve press then rejects.
 */

export function findNode(root: MindMapNode, id: string): MindMapNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** 1 for the root, 2 for a chapter, 3 for a theme, 4 for a concept; `null` for an id the tree does not hold. */
export function depthOf(root: MindMapNode, id: string, depth = 1): number | null {
  if (root.id === id) return depth;
  for (const child of root.children) {
    const found = depthOf(child, id, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** How many levels this node and what is under it take up. A leaf is 1. */
export function subtreeDepth(node: MindMapNode): number {
  return 1 + node.children.reduce((deepest, child) => Math.max(deepest, subtreeDepth(child)), 0);
}

export function parentOf(root: MindMapNode, id: string): MindMapNode | null {
  for (const child of root.children) {
    if (child.id === id) return root;
    const found = parentOf(child, id);
    if (found !== null) return found;
  }
  return null;
}

function isDescendant(node: MindMapNode, id: string): boolean {
  return node.children.some((child) => child.id === id || isDescendant(child, id));
}

function mapTree(root: MindMapNode, visit: (node: MindMapNode) => MindMapNode): MindMapNode {
  return visit({ ...root, children: root.children.map((child) => mapTree(child, visit)) });
}

export function renameNode(root: MindMapNode, id: string, label: string): MindMapNode {
  return mapTree(root, (node) => (node.id === id ? { ...node, label } : node));
}

/** Remove a node and everything under it. The root cannot be removed and comes back unchanged. */
export function removeNode(root: MindMapNode, id: string): MindMapNode {
  if (root.id === id) return root;
  return mapTree(root, (node) => ({
    ...node,
    children: node.children.filter((child) => child.id !== id),
  }));
}

/** How many children a node at this depth may hold — the server's table, read here. */
export function childCap(depth: number): number {
  return mindMapChildCap(depth);
}

/** Whether a new child fits under this node. */
export function canAddUnder(root: MindMapNode, parentId: string): boolean {
  const depth = depthOf(root, parentId);
  const parent = findNode(root, parentId);
  if (depth === null || parent === null) return false;
  return parent.children.length < childCap(depth);
}

/** An id no node in the tree carries. `e` for "entered", as the machine's are `n` and the server's `a`. */
export function nextNodeId(root: MindMapNode): string {
  const taken = new Set<string>();
  const collect = (node: MindMapNode): void => {
    taken.add(node.id);
    node.children.forEach(collect);
  };
  collect(root);
  let counter = 1;
  while (taken.has(`e${counter}`)) counter += 1;
  return `e${counter}`;
}

export function addChild(
  root: MindMapNode,
  parentId: string,
  label: string,
  id: string = nextNodeId(root),
): MindMapNode {
  if (!canAddUnder(root, parentId)) return root;
  const child: MindMapNode = { id, label, anchorMs: null, children: [] };
  return mapTree(root, (node) =>
    node.id === parentId ? { ...node, children: [...node.children, child] } : node,
  );
}

/**
 * Whether `id` may be moved under `targetId`: not onto itself or into its own subtree, not where it
 * already is, and only where the result still fits the map's depth and the target's cap.
 */
export function canMoveUnder(root: MindMapNode, id: string, targetId: string): boolean {
  if (id === targetId || id === root.id) return false;
  const moving = findNode(root, id);
  const target = findNode(root, targetId);
  const targetDepth = depthOf(root, targetId);
  if (moving === null || target === null || targetDepth === null) return false;
  if (isDescendant(moving, targetId)) return false;
  if (parentOf(root, id)?.id === targetId) return false;
  if (targetDepth + subtreeDepth(moving) > MIND_MAP_MAX_DEPTH) return false;
  return target.children.length < childCap(targetDepth);
}

/** Move a node, with its subtree, under another. Comes back unchanged when the move is not allowed. */
export function moveNode(root: MindMapNode, id: string, targetId: string): MindMapNode {
  if (!canMoveUnder(root, id, targetId)) return root;
  const moving = findNode(root, id);
  if (moving === null) return root;
  const without = removeNode(root, id);
  return mapTree(without, (node) =>
    node.id === targetId ? { ...node, children: [...node.children, moving] } : node,
  );
}
