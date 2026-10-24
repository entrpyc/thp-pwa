import { buildMindMapTree, type MindMapNode } from '@thp/shared';

/**
 * **Turn what the model proposed into the tree a draft holds**, counting what did not fit
 * ([3.8.1](docs/project/prd.md)).
 *
 * The same seam `scripture-draft.ts` is for citations: the adapter guarantees only that a tree of
 * themes came back; whether every theme and point fits a map — depth, breadth, a label at all — is
 * the product's rule, applied here once through `@thp/shared`'s normaliser and nowhere inside a
 * vendor file. What is dropped is a number on the job that produced it, so a prompt that starts
 * writing twelve themes is visible rather than quiet.
 */

export interface MindMapDraft {
  readonly root: MindMapNode;
  readonly dropped: number;
}

export function resolveProposedMindMap(title: string, proposed: unknown): MindMapDraft {
  const built = buildMindMapTree(title, proposed);
  return { root: built.root, dropped: built.dropped };
}
