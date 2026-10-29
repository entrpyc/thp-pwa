'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { formatTimecode, type MindMapNode } from '@thp/shared';
import { layoutMindMap, type LayoutNode } from './layout';
import { addChild, canAddUnder, canMoveUnder, moveNode, removeNode, renameNode } from './tree-edit';
import styles from './mind-map-canvas.module.css';

/**
 * **The mind map, drawn** ([3.8.3](docs/project/prd.md), [3.8.4](docs/project/prd.md)) — and, for
 * an admin, edited in place ([3.8.2](docs/project/prd.md)).
 *
 * One component on three screens: the recording page's `Mindmap` tab reads the whole map, the
 * chapter page's reads one chapter's branch with that chapter as root, and the review form curates
 * it with `editable` on. The same boxes, the same layout, the same expand and collapse — so what an
 * admin approves is what a member sees, which is the property a separate editor could only promise.
 *
 * - **HTML boxes over an SVG of edges**, not a graph library. The layout is `layout.ts`'s pure
 *   function; the boxes are real elements, so the tree is walkable from a keyboard and the colours
 *   are the token layer's. The SVG draws nothing but curves.
 * - **Everything opens at once.** The map is read whole and folded by hand: a box with children
 *   carries a fold control on its right — a chevron behind a divider that runs the box's full
 *   height — and pressing anywhere right of the divider folds or unfolds the branch. Nothing else
 *   does, so a member cannot collapse a branch by reaching for a label or a timestamp. The root has
 *   no control, because a map folded to its title is no map.
 * - **A node that names a moment carries a chip** with its timecode and a small play control
 *   before it. The time is `onSeek` — which, on the recording page, goes to the moment **without
 *   starting sound**, as the transcript's lines do (3.5.4); the play control is `onPlay`, which
 *   goes there and plays. Where nothing handles a seek, the chip is text, and where nothing
 *   handles a play, there is no play control.
 * - **It pans.** The picture is wider than a phone, so the scroller scrolls both ways, by touch as
 *   any scroll region does and by dragging with a mouse. There is no zoom: the boxes are already
 *   sized to be read at one scale, and a smaller map is a folded one.
 * - **Editing is per node and never modal.** Rename puts an input where the label was; Remove
 *   takes the node and its subtree; Add puts a new node under it; Move marks it and every node it
 *   may go under grows a *Put here*. The rules for what fits — four levels and the caps per level —
 *   are `tree-edit.ts`'s and the server's alike, so the form never builds a tree the approve press
 *   refuses.
 */

export interface MindMapCanvasProps {
  readonly root: MindMapNode;
  /** The accessible name of the region. */
  readonly label: string;
  /** Sizing from the parent — the inline panel's height, or the full-screen fill. */
  readonly className?: string | undefined;
  readonly editable?: boolean;
  /** Required when `editable`: every edit hands back a new root. */
  readonly onChange?: (root: MindMapNode) => void;
  /** Go to a moment without starting sound. When absent, timestamp chips are text, not controls. */
  readonly onSeek?: (ms: number) => void;
  /** Go to a moment and play. When absent, chips carry no play control. */
  readonly onPlay?: (ms: number) => void;
  /** A branch folded (`true`) or unfolded by hand — for the caller's own bookkeeping, nothing more. */
  readonly onFold?: (folded: boolean) => void;
}

/** The height the editing controls add to every box, which the layout has to know about. */
const TOOLS_HEIGHT = 34;

/** Every node of the tree that has something under it — the opening state of the map. */
function allBranches(root: MindMapNode): Set<string> {
  const ids = new Set<string>();
  const visit = (node: MindMapNode): void => {
    if (node.children.length > 0) ids.add(node.id);
    node.children.forEach(visit);
  };
  visit(root);
  return ids;
}

export function MindMapCanvas({
  root,
  label,
  className,
  editable = false,
  onChange,
  onSeek,
  onPlay,
  onFold,
}: MindMapCanvasProps) {
  /** Which nodes show their children. Everything starts open; a member folds what they are done with. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => allBranches(root));
  const [moving, setMoving] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);

  // A different tree — a regenerated draft under the same form — starts open again.
  useEffect(() => {
    setExpanded(allBranches(root));
    setMoving(null);
    setRenaming(null);
  }, [root.id]);

  const layout = useMemo(
    () => layoutMindMap(root, expanded, editable ? { extraHeight: TOOLS_HEIGHT } : {}),
    [root, expanded, editable],
  );

  const toggle = useCallback(
    (id: string) => {
      // Read outside the updater, which may run twice in development.
      onFold?.(expanded.has(id));
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [expanded, onFold],
  );

  const change = (next: MindMapNode): void => {
    if (next !== root) onChange?.(next);
  };

  // ------------------------------------------------------------------------- drag to pan (mouse)
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Touch pans by scrolling already; a press on a control is a press, not a drag.
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input')) return;
    const element = scroller.current;
    if (element === null) return;
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    const element = scroller.current;
    if (start === null || element === null) return;
    element.scrollLeft = start.left - (event.clientX - start.x);
    element.scrollTop = start.top - (event.clientY - start.y);
  };
  const onPointerUp = (): void => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={scroller}
      className={`${styles.scroller}${className === undefined ? '' : ` ${className}`}`}
      role="group"
      aria-label={label}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className={styles.stage} style={{ width: layout.width, height: layout.height }}>
        <svg
          className={styles.edges}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
        >
          {layout.edges.map((edge) => (
            <path key={`${edge.from}-${edge.to}`} className={styles.edge} d={edge.d} />
          ))}
        </svg>

        {layout.nodes.map((placed) => (
          <NodeBox
            key={placed.id}
            placed={placed}
            root={root}
            editable={editable}
            moving={moving}
            renaming={renaming?.id === placed.id ? renaming.draft : null}
            onToggle={toggle}
            {...(onSeek === undefined ? {} : { onSeek })}
            {...(onPlay === undefined ? {} : { onPlay })}
            onStartRename={(id, draft) => setRenaming({ id, draft })}
            onRenameDraft={(draft) => setRenaming((current) => (current === null ? null : { ...current, draft }))}
            onCommitRename={() => {
              if (renaming === null) return;
              const next = renaming.draft.trim();
              if (next !== '') change(renameNode(root, renaming.id, next));
              setRenaming(null);
            }}
            onCancelRename={() => setRenaming(null)}
            onRemove={(id) => change(removeNode(root, id))}
            onAdd={(id) => {
              change(addChild(root, id, 'New point'));
              setExpanded((current) => new Set([...current, id]));
            }}
            onStartMove={(id) => setMoving(id)}
            onCancelMove={() => setMoving(null)}
            onPutHere={(targetId) => {
              if (moving === null) return;
              change(moveNode(root, moving, targetId));
              setExpanded((current) => new Set([...current, targetId]));
              setMoving(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function NodeBox({
  placed,
  root,
  editable,
  moving,
  renaming,
  onToggle,
  onSeek,
  onPlay,
  onStartRename,
  onRenameDraft,
  onCommitRename,
  onCancelRename,
  onRemove,
  onAdd,
  onStartMove,
  onCancelMove,
  onPutHere,
}: {
  placed: LayoutNode;
  root: MindMapNode;
  editable: boolean;
  moving: string | null;
  /** The rename draft while this node is being renamed, else `null`. */
  renaming: string | null;
  onToggle: (id: string) => void;
  onSeek?: (ms: number) => void;
  onPlay?: (ms: number) => void;
  onStartRename: (id: string, draft: string) => void;
  onRenameDraft: (draft: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  onStartMove: (id: string) => void;
  onCancelMove: () => void;
  onPutHere: (targetId: string) => void;
}) {
  const { node, depth } = placed;
  const isRoot = depth === 1;
  const foldable = node.children.length > 0 && !isRoot;
  const tone =
    isRoot ? styles.root : depth === 2 ? styles.chapter : depth === 3 ? styles.theme : styles.point;
  const timecode = node.anchorMs === null ? null : formatTimecode(node.anchorMs);
  const isMoving = moving === node.id;
  const canReceive = moving !== null && !isMoving && canMoveUnder(root, moving, node.id);

  return (
    <div
      className={`${styles.node} ${tone}${isMoving ? ` ${styles.moving}` : ''}`}
      style={{ left: placed.x, top: placed.y, width: placed.width, minHeight: placed.height }}
      data-depth={depth}
      data-node-id={node.id}
    >
      <div className={styles.body}>
        {renaming !== null ? (
          <input
            className={styles.rename}
            aria-label={`Rename ${node.label}`}
            value={renaming}
            autoFocus
            onChange={(event) => onRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCommitRename();
              if (event.key === 'Escape') onCancelRename();
            }}
          />
        ) : (
          <span className={styles.label}>{node.label}</span>
        )}

        {timecode === null ? null : (
          <span className={styles.chip}>
            {onPlay === undefined ? null : (
              <button
                className={styles.play}
                type="button"
                aria-label={`Play from ${timecode}`}
                onClick={() => onPlay(node.anchorMs ?? 0)}
              >
                <span aria-hidden="true">▶</span>
              </button>
            )}
            {onSeek === undefined ? (
              <span className={styles.time}>{timecode}</span>
            ) : (
              <button
                className={`${styles.time} ${styles.timeButton}`}
                type="button"
                aria-label={`Go to ${timecode}`}
                onClick={() => onSeek(node.anchorMs ?? 0)}
              >
                {timecode}
              </button>
            )}
          </span>
        )}

        {editable ? (
          <div className={styles.tools}>
            {renaming !== null ? (
              <>
                <button className={styles.toolStrong} type="button" onClick={onCommitRename}>
                  Save
                </button>
                <button className={styles.tool} type="button" onClick={onCancelRename}>
                  Cancel
                </button>
              </>
            ) : moving !== null ? (
              isMoving ? (
                <button className={styles.toolStrong} type="button" onClick={onCancelMove}>
                  Cancel move
                </button>
              ) : canReceive ? (
                <button
                  className={styles.toolStrong}
                  type="button"
                  aria-label={`Put it under ${node.label}`}
                  onClick={() => onPutHere(node.id)}
                >
                  Put here
                </button>
              ) : null
            ) : (
              <>
                <button
                  className={styles.tool}
                  type="button"
                  aria-label={`Rename ${node.label}`}
                  onClick={() => onStartRename(node.id, node.label)}
                >
                  Rename
                </button>
                {canAddUnder(root, node.id) ? (
                  <button
                    className={styles.tool}
                    type="button"
                    aria-label={`Add a point under ${node.label}`}
                    onClick={() => onAdd(node.id)}
                  >
                    Add
                  </button>
                ) : null}
                {isRoot ? null : (
                  <>
                    <button
                      className={styles.tool}
                      type="button"
                      aria-label={`Move ${node.label}`}
                      onClick={() => onStartMove(node.id)}
                    >
                      Move
                    </button>
                    <button
                      className={styles.tool}
                      type="button"
                      aria-label={`Remove ${node.label}`}
                      onClick={() => onRemove(node.id)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>

      {/*
        The fold control: the whole strip right of the divider, top to bottom, so there is no
        part of it a press misses. The chevron points right when the branch is folded and down
        when it is open, the way a disclosure does.
      */}
      {foldable ? (
        <button
          className={styles.toggle}
          type="button"
          aria-expanded={placed.expanded}
          aria-label={`${placed.expanded ? 'Collapse' : 'Expand'} ${node.label}`}
          onClick={() => onToggle(node.id)}
        >
          <span className={styles.chevron} aria-hidden="true">
            ›
          </span>
        </button>
      ) : null}
    </div>
  );
}
