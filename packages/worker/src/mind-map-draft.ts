import {
  buildChapteredMindMapTree,
  buildMindMapTree,
  type MindMapNode,
  type ProposedChapterMap,
} from '@thp/shared';

/**
 * **Turn what the model proposed into the tree a draft holds**, counting what did not fit
 * ([3.8.1](docs/project/prd.md)).
 *
 * The same seam `scripture-draft.ts` is for citations: the adapter guarantees only that a tree of
 * themes came back; whether every theme and concept fits a map — depth, breadth, a label at all —
 * is the product's rule, applied here once through `@thp/shared`'s normaliser and nowhere inside a
 * vendor file. What is dropped is a number on the job that produced it, so a prompt that starts
 * writing twelve themes is visible rather than quiet.
 *
 * Two shapes, one per kind of teaching. A teaching with chapters is mapped **chapter by chapter**:
 * the model answers once per chapter, reading only that chapter's lines, and the chapters
 * themselves are the first level of the tree. A teaching too short to hold chapters
 * ([3.22.4](docs/project/prd.md)) is mapped in one answer, its themes straight under the root.
 */

export interface MindMapDraft {
  readonly root: MindMapNode;
  readonly dropped: number;
}

/** A teaching with no chapters: the one proposal, read as the themes under the root. */
export function resolveProposedMindMap(title: string, proposed: unknown): MindMapDraft {
  const built = buildMindMapTree(title, proposed);
  return { root: built.root, dropped: built.dropped };
}

/** A teaching with chapters: one proposal per chapter, each read as the themes under its chapter. */
export function resolveChapteredMindMap(
  title: string,
  chapters: readonly ProposedChapterMap[],
): MindMapDraft {
  const built = buildChapteredMindMapTree(title, chapters);
  return { root: built.root, dropped: built.dropped };
}
