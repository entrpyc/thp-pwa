import { describe, expect, it } from 'vitest';
import {
  MIND_MAP_MAX_LABEL_LENGTH,
  MIND_MAP_MAX_POINTS,
  MIND_MAP_MAX_THEMES,
  buildMindMapTree,
  checkMindMapTree,
  countMindMapNodes,
  isMindMapNode,
  mindMapsEqual,
  type MindMapNode,
} from '../../src/mind-maps';

/**
 * **What a mind map is, as the one normaliser decides it** ([3.8.1](docs/project/prd.md)).
 *
 * Two readers over the same rules: the worker's lenient one, which drops what does not fit and
 * counts it, and the approve path's strict one, which refuses with a sentence. Both are asserted
 * here against the same shapes so they cannot disagree about depth, breadth or a blank label.
 */

const PROPOSED = {
  themes: [
    {
      label: '  Grace  ',
      anchorMs: 4000,
      points: [
        { label: 'Unearned', anchorMs: 4000 },
        { label: 'Given, not taken' },
        { label: '', anchorMs: 1 },
      ],
    },
    { label: 'Law', points: [] },
  ],
};

describe('building the tree from a proposal', () => {
  it('makes the title the root, themes its children, points theirs, with ids in document order', () => {
    const { root, dropped } = buildMindMapTree('A teaching', PROPOSED);

    expect(root.id).toBe('n1');
    expect(root.label).toBe('A teaching');
    expect(root.anchorMs).toBeNull();
    expect(root.children.map((one) => one.label)).toEqual(['Grace', 'Law']);
    expect(root.children[0]?.id).toBe('n2');
    expect(root.children[0]?.anchorMs).toBe(4000);
    expect(root.children[0]?.children.map((one) => [one.id, one.label, one.anchorMs])).toEqual([
      ['n3', 'Unearned', 4000],
      ['n4', 'Given, not taken', null],
    ]);
    // The blank point is the one thing dropped.
    expect(dropped).toBe(1);
  });

  it('caps themes and points, and counts what did not fit', () => {
    const themes = Array.from({ length: MIND_MAP_MAX_THEMES + 2 }, (_, index) => ({
      label: `Theme ${index + 1}`,
      points: Array.from({ length: MIND_MAP_MAX_POINTS + 1 }, (_, at) => ({ label: `Point ${at + 1}` })),
    }));

    const { root, dropped } = buildMindMapTree('T', { themes });

    expect(root.children).toHaveLength(MIND_MAP_MAX_THEMES);
    expect(root.children.every((one) => one.children.length === MIND_MAP_MAX_POINTS)).toBe(true);
    // Two whole themes past the cap, and one point past the cap in each kept theme.
    expect(dropped).toBe(2 + MIND_MAP_MAX_THEMES);
  });

  it('keeps nothing under a point, and counts the nesting it refused', () => {
    const { root, dropped } = buildMindMapTree('T', {
      themes: [{ label: 'A', points: [{ label: 'B', points: [{ label: 'C', points: [{ label: 'D' }] }] }] }],
    });

    expect(root.children[0]?.children[0]?.children).toEqual([]);
    expect(dropped).toBe(2);
  });

  it('reads a bad anchor as no anchor, and cuts a label that runs on', () => {
    const long = 'x'.repeat(MIND_MAP_MAX_LABEL_LENGTH + 40);
    const { root } = buildMindMapTree('T', {
      themes: [{ label: long, anchorMs: -5, points: [{ label: 'p', anchorMs: 1.5 }] }],
    });

    expect(root.children[0]?.label).toHaveLength(MIND_MAP_MAX_LABEL_LENGTH);
    expect(root.children[0]?.anchorMs).toBeNull();
    expect(root.children[0]?.children[0]?.anchorMs).toBeNull();
  });

  it('answers a root with no themes for a proposal that has none, rather than failing', () => {
    expect(buildMindMapTree('T', { themes: 'none' }).root.children).toEqual([]);
    expect(buildMindMapTree('T', null).root.children).toEqual([]);
    expect(buildMindMapTree('   ', {}).root.label).toBe('This teaching');
  });
});

describe('checking a tree strictly', () => {
  const good: MindMapNode = buildMindMapTree('A teaching', PROPOSED).root;

  it('admits what the builder produced, unchanged', () => {
    const checked = checkMindMapTree(good);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.root).toEqual(good);
    expect(isMindMapNode(good)).toBe(true);
  });

  it('refuses a blank label, naming where', () => {
    const checked = checkMindMapTree({
      ...good,
      children: [{ id: 'x', label: '   ', anchorMs: null, children: [] }],
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problem.message).toContain('Node 1 under “A teaching”');
  });

  it('refuses too many themes, too many points and a fourth level', () => {
    const themes = Array.from({ length: MIND_MAP_MAX_THEMES + 1 }, (_, index) => ({
      id: `t${index}`,
      label: `Theme ${index}`,
      anchorMs: null,
      children: [],
    }));
    expect(checkMindMapTree({ ...good, children: themes }).ok).toBe(false);

    const points = Array.from({ length: MIND_MAP_MAX_POINTS + 1 }, (_, index) => ({
      id: `p${index}`,
      label: `Point ${index}`,
      anchorMs: null,
      children: [],
    }));
    const wide = checkMindMapTree({
      ...good,
      children: [{ id: 't', label: 'Theme', anchorMs: null, children: points }],
    });
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.problem.message).toContain(`at most ${MIND_MAP_MAX_POINTS}`);

    const deep = checkMindMapTree({
      ...good,
      children: [
        {
          id: 't',
          label: 'Theme',
          anchorMs: null,
          children: [
            {
              id: 'p',
              label: 'Point',
              anchorMs: null,
              children: [{ id: 'q', label: 'Too deep', anchorMs: null, children: [] }],
            },
          ],
        },
      ],
    });
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.problem.message).toContain('levels deep');
  });

  it('refuses an anchor that is not an offset, and reads a missing one as none', () => {
    expect(
      checkMindMapTree({ id: 'r', label: 'R', anchorMs: -1, children: [] }).ok,
    ).toBe(false);
    const checked = checkMindMapTree({ id: 'r', label: 'R', children: [] });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.root.anchorMs).toBeNull();
  });

  it('mints an id for a node that has none or repeats one, and keeps the rest', () => {
    const checked = checkMindMapTree({
      id: 'r',
      label: 'R',
      anchorMs: null,
      children: [
        { label: 'Added in the form', anchorMs: null, children: [] },
        { id: 'r', label: 'Repeats the root', anchorMs: null, children: [] },
        { id: 'kept', label: 'Kept', anchorMs: null, children: [] },
      ],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const ids = [checked.root.id, ...checked.root.children.map((one) => one.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('kept');
    expect(ids).toContain('r');
  });
});

describe('what the tree is for', () => {
  it('counts every node, root included', () => {
    expect(countMindMapNodes(buildMindMapTree('T', PROPOSED).root)).toBe(5);
  });

  it('compares two trees by words, moments and shape, never by id', () => {
    const a = buildMindMapTree('T', PROPOSED).root;
    const checked = checkMindMapTree({
      ...a,
      id: 'other',
      children: a.children.map((one) => ({ ...one, id: `${one.id}-x` })),
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(mindMapsEqual(a, checked.root)).toBe(true);

    const renamed = { ...a, children: [{ ...a.children[0]!, label: 'Mercy' }, a.children[1]!] };
    expect(mindMapsEqual(a, renamed)).toBe(false);
    const moved = { ...a, children: [a.children[1]!, a.children[0]!] };
    expect(mindMapsEqual(a, moved)).toBe(false);
  });
});
