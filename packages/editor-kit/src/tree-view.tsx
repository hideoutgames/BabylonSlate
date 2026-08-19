import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "./use-context-menu";

/** Row height matches `--chrome-row` (28px). */
export const TREE_ROW_HEIGHT = 28;
/** Horizontal swipe distance that adds a row to the selection (touch target). */
export const TREE_SWIPE_ADD_PX = 44;
/** Top/bottom band that inserts as a sibling instead of nesting into the row. */
export const TREE_DROP_EDGE_PX = 8;

export type TreeDropPlacement = "before" | "into" | "after";

export function treeDropPlacement(
  offsetY: number,
  rowHeight: number = TREE_ROW_HEIGHT,
  edgePx: number = TREE_DROP_EDGE_PX,
): TreeDropPlacement {
  if (offsetY < edgePx) return "before";
  if (offsetY >= rowHeight - edgePx) return "after";
  return "into";
}

export type TreeSelectOptions = {
  additive?: boolean;
  range?: boolean;
};

export function rangeSelectTreeIds(
  ids: readonly string[],
  fromId: string | null | undefined,
  toId: string,
): string[] {
  const toIndex = ids.indexOf(toId);
  if (toIndex < 0) return [toId];
  const fromIndex = fromId ? ids.indexOf(fromId) : -1;
  if (fromIndex < 0) return [toId];
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return ids.slice(start, end + 1);
}

export function isTreeSwipeAdd(dx: number, dy: number): boolean {
  return Math.abs(dx) >= TREE_SWIPE_ADD_PX && Math.abs(dx) >= Math.abs(dy);
}

export interface TreeViewNode {
  id: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Trailing controls such as visibility and lock toggles. */
  trailing?: ReactNode;
  /** Optional type cue, rendered between the disclosure and the label. */
  icon?: ReactNode;
  muted?: boolean;
}

export interface TreeViewProps {
  /** Flattened list of visible rows, parents before children. */
  nodes: TreeViewNode[];
  selectedId?: string | null;
  /** When set, every listed id is highlighted; otherwise `selectedId`. */
  selectedIds?: readonly string[];
  onSelect?: (id: string, options?: TreeSelectOptions) => void;
  onToggleExpanded?: (id: string) => void;
  /**
   * Drop `dragId` relative to `targetId`. `into` (default) nests under the row;
   * `before` / `after` insert as a sibling. Null `targetId` means the scene root.
   */
  onReparent?: (
    dragId: string,
    targetId: string | null,
    placement?: TreeDropPlacement,
  ) => void;
  /** Drop a row onto a client point outside the tree (graph canvas spawn). */
  onExternalDrop?: (id: string, clientX: number, clientY: number) => void;
  /** Fired while an external drag is armed (for graph drop hints). */
  onExternalDragMove?: (
    id: string,
    clientX: number,
    clientY: number,
  ) => void;
  onExternalDragEnd?: () => void;
  /** Double-tap / double-click a row (frame camera, open, …). */
  onActivate?: (id: string) => void;
  onContextMenu?: (id: string, clientX: number, clientY: number) => void;
  /** Immediate: pointer move past 8px starts a parent drag. Hold: 250ms arm (Content Browser). */
  reparentArm?: "immediate" | "hold";
  rowHeight?: number;
  emptyLabel?: string;
  "data-testid"?: string;
}

interface DragState {
  pointerId: number;
  nodeId: string;
  startX: number;
  startY: number;
  armed: boolean;
  canDrag: boolean;
  moved: boolean;
  swipeAdd: boolean;
  dragArmTimer: ReturnType<typeof setTimeout> | null;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

interface ExtraPointer {
  pointerId: number;
  nodeId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

interface DropHint {
  id: string | null;
  placement: TreeDropPlacement;
}

/**
 * Virtualized touch tree. Rows are fixed height so the visible window is
 * arithmetic rather than measurement, which keeps scrolling allocation-free.
 */
export function TreeView({
  nodes,
  selectedId = null,
  selectedIds,
  onSelect,
  onToggleExpanded,
  onReparent,
  onExternalDrop,
  onExternalDragMove,
  onExternalDragEnd,
  onActivate,
  onContextMenu,
  reparentArm = "hold",
  rowHeight = TREE_ROW_HEIGHT,
  emptyLabel = "Nothing here yet",
  "data-testid": testId,
}: TreeViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const extraPointerRef = useRef<ExtraPointer | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dropHint, setDropHint] = useState<DropHint | undefined>(undefined);
  const selectedSet = new Set(
    selectedIds ?? (selectedId !== null && selectedId !== undefined ? [selectedId] : []),
  );

  const overscan = 4;
  // jsdom and first paint report a zero-height client rect; render everything
  // rather than nothing so tests and the first frame both see real rows.
  const windowed = viewportHeight > 0;
  const firstIndex = windowed
    ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    : 0;
  const lastIndex = windowed
    ? Math.min(
        nodes.length,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
      )
    : nodes.length;
  const visible = nodes.slice(firstIndex, lastIndex);

  const measure = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element) {
      setViewportHeight(element.clientHeight);
    }
  }, []);

  const dropAtClientY = useCallback(
    (clientY: number): DropHint => {
      const container = containerRef.current;
      if (!container) return { id: null, placement: "into" };
      const rect = container.getBoundingClientRect();
      const y = clientY - rect.top + container.scrollTop;
      if (y < 0 || y >= nodes.length * rowHeight) {
        return { id: null, placement: "into" };
      }
      const index = Math.floor(y / rowHeight);
      const offsetY = y - index * rowHeight;
      return {
        id: nodes[index]?.id ?? null,
        placement: treeDropPlacement(offsetY, rowHeight),
      };
    },
    [nodes, rowHeight],
  );

  const pointerInsideTree = useCallback(
    (clientX: number, clientY: number): boolean => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return true;
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    },
    [],
  );

  const lastTapRef = useRef<{ id: string; at: number } | null>(null);

  const clearDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.longPressTimer) clearTimeout(drag.longPressTimer);
    if (drag?.dragArmTimer) clearTimeout(drag.dragArmTimer);
    if (
      drag &&
      containerRef.current?.hasPointerCapture?.(drag.pointerId)
    ) {
      try {
        containerRef.current.releasePointerCapture(drag.pointerId);
      } catch {
        /* jsdom and detached nodes */
      }
    }
    const wasArmed = Boolean(drag?.armed);
    dragRef.current = null;
    extraPointerRef.current = null;
    setDropHint(undefined);
    if (wasArmed) onExternalDragEnd?.();
  }, [onExternalDragEnd]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
      const existing = dragRef.current;
      if (existing && existing.pointerId !== event.pointerId) {
        extraPointerRef.current = {
          pointerId: event.pointerId,
          nodeId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        if (existing.longPressTimer) clearTimeout(existing.longPressTimer);
        existing.longPressTimer = null;
        if (existing.dragArmTimer) clearTimeout(existing.dragArmTimer);
        existing.dragArmTimer = null;
        existing.canDrag = false;
        return;
      }
      const longPressTimer = onContextMenu
        ? setTimeout(() => {
            const drag = dragRef.current;
            if (!drag || drag.armed || drag.moved || extraPointerRef.current) {
              return;
            }
            if (containerRef.current?.hasPointerCapture?.(drag.pointerId)) {
              try {
                containerRef.current.releasePointerCapture(drag.pointerId);
              } catch {
                /* jsdom */
              }
            }
            dragRef.current = null;
            onContextMenu(nodeId, event.clientX, event.clientY);
          }, CONTEXT_MENU_LONG_PRESS_MS)
        : null;
      const canDragNow =
        (Boolean(onReparent) && reparentArm === "immediate") ||
        (Boolean(onExternalDrop) && event.pointerType === "mouse");
      const holdDrag = Boolean(onReparent || onExternalDrop) && !canDragNow;
      const dragArmTimer = holdDrag
        ? setTimeout(() => {
            const drag = dragRef.current;
            if (!drag || drag.moved || extraPointerRef.current) return;
            drag.canDrag = true;
            try {
              containerRef.current?.setPointerCapture?.(drag.pointerId);
            } catch {
              /* jsdom and detached nodes */
            }
          }, DRAG_ARM_MS)
        : null;
      dragRef.current = {
        pointerId: event.pointerId,
        nodeId,
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        canDrag: canDragNow,
        moved: false,
        swipeAdd: false,
        dragArmTimer,
        longPressTimer,
      };
      if (canDragNow) {
        try {
          containerRef.current?.setPointerCapture?.(event.pointerId);
        } catch {
          /* jsdom and detached nodes */
        }
      }
    },
    [onContextMenu, onExternalDrop, onReparent, reparentArm],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const extra = extraPointerRef.current;
      if (extra && extra.pointerId === event.pointerId) {
        const extraMoved = Math.hypot(
          event.clientX - extra.startX,
          event.clientY - extra.startY,
        );
        if (extraMoved > CONTEXT_MENU_MOVE_TOLERANCE_PX) extra.moved = true;
        return;
      }
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const moved = Math.hypot(dx, dy);
      if (moved <= CONTEXT_MENU_MOVE_TOLERANCE_PX) return;
      drag.moved = true;
      const inside = pointerInsideTree(event.clientX, event.clientY);
      if (inside && isTreeSwipeAdd(dx, dy) && !onExternalDrop) {
        drag.swipeAdd = true;
        drag.canDrag = false;
        drag.armed = false;
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
        if (drag.dragArmTimer) clearTimeout(drag.dragArmTimer);
        drag.dragArmTimer = null;
        setDropHint(undefined);
        return;
      }
      if (extraPointerRef.current) {
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
        if (drag.dragArmTimer) clearTimeout(drag.dragArmTimer);
        drag.dragArmTimer = null;
        return;
      }
      if (!drag.canDrag) {
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
        if (drag.dragArmTimer) clearTimeout(drag.dragArmTimer);
        drag.dragArmTimer = null;
        return;
      }
      if (!drag.armed) {
        drag.armed = true;
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
      if (!inside && onExternalDrop) {
        setDropHint(undefined);
        onExternalDragMove?.(drag.nodeId, event.clientX, event.clientY);
        return;
      }
      if (onReparent) {
        const target = dropAtClientY(event.clientY);
        setDropHint(target.id === drag.nodeId ? undefined : target);
        return;
      }
      onExternalDragMove?.(drag.nodeId, event.clientX, event.clientY);
    },
    [
      dropAtClientY,
      onExternalDragMove,
      onExternalDrop,
      onReparent,
      pointerInsideTree,
    ],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const extra = extraPointerRef.current;
      const drag = dragRef.current;
      if (extra && extra.pointerId === event.pointerId) {
        extraPointerRef.current = null;
        if (drag && !extra.moved && !drag.moved && !drag.armed) {
          onSelect?.(extra.nodeId, { range: true });
          clearDrag();
        }
        return;
      }
      if (!drag || drag.pointerId !== event.pointerId) {
        clearDrag();
        return;
      }
      if (extraPointerRef.current) {
        if (!drag.moved && !extraPointerRef.current.moved && !drag.armed) {
          onSelect?.(extraPointerRef.current.nodeId, { range: true });
        }
        clearDrag();
        return;
      }
      if (drag.swipeAdd) {
        onSelect?.(drag.nodeId, { additive: true });
      } else if (drag.armed) {
        const inside = pointerInsideTree(event.clientX, event.clientY);
        if (!inside && onExternalDrop) {
          onExternalDrop(drag.nodeId, event.clientX, event.clientY);
        } else if (onReparent) {
          const target = dropAtClientY(event.clientY);
          if (target.id !== drag.nodeId) {
            onReparent(drag.nodeId, target.id, target.placement);
          }
        }
      } else if (!drag.armed && !drag.moved) {
        const additive = event.ctrlKey || event.metaKey || event.shiftKey;
        if (additive) {
          onSelect?.(drag.nodeId, { additive: true });
        } else {
          onSelect?.(drag.nodeId);
        }
        const now = Date.now();
        const last = lastTapRef.current;
        if (last && last.id === drag.nodeId && now - last.at <= 350) {
          onActivate?.(drag.nodeId);
          lastTapRef.current = null;
        } else {
          lastTapRef.current = { id: drag.nodeId, at: now };
        }
      }
      clearDrag();
    },
    [
      clearDrag,
      dropAtClientY,
      onActivate,
      onExternalDrop,
      onReparent,
      onSelect,
      pointerInsideTree,
    ],
  );

  return (
    <div
      ref={measure}
      className="h-full min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y"
      data-testid={testId}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={clearDrag}
    >
      {nodes.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div style={{ height: nodes.length * rowHeight, position: "relative" }}>
          {visible.map((node, index) => {
            const top = (firstIndex + index) * rowHeight;
            const selected = selectedSet.has(node.id);
            const placement =
              dropHint?.id === node.id ? dropHint.placement : undefined;
            const dropInto = placement === "into";
            const dropBefore = placement === "before";
            const dropAfter = placement === "after";
            const insertLeft = node.depth * 16 + 8;
            return (
              <div
                key={node.id}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={node.hasChildren ? node.expanded : undefined}
                data-testid={`tree-row-${node.id}`}
                data-depth={node.depth}
                data-drop-target={dropInto ? "true" : undefined}
                data-drop-before={dropBefore ? "true" : undefined}
                data-drop-after={dropAfter ? "true" : undefined}
                className={cn(
                  "absolute right-0 left-0 flex items-center gap-1 border-l-2 px-1 text-sm",
                  selected
                    ? "border-l-primary bg-primary/20 font-medium"
                    : "border-l-transparent hover:bg-accent/50",
                  dropInto ? "outline outline-1 outline-ring" : "",
                )}
                style={{
                  top,
                  height: rowHeight,
                  paddingLeft: `${insertLeft}px`,
                }}
                onPointerDown={(event) => onPointerDown(event, node.id)}
                onContextMenu={(event) => {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  onContextMenu(node.id, event.clientX, event.clientY);
                }}
              >
                {dropBefore ? (
                  <span
                    aria-hidden
                    data-testid={`tree-drop-before-${node.id}`}
                    className="pointer-events-none absolute top-0 right-0 h-px bg-ring"
                    style={{ left: insertLeft }}
                  />
                ) : null}
                {dropAfter ? (
                  <span
                    aria-hidden
                    data-testid={`tree-drop-after-${node.id}`}
                    className="pointer-events-none absolute right-0 bottom-0 h-px bg-ring"
                    style={{ left: insertLeft }}
                  />
                ) : null}
                {node.hasChildren ? (
                  <button
                    type="button"
                    aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.label}`}
                    className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleExpanded?.(node.id);
                    }}
                    data-testid={`tree-disclosure-${node.id}`}
                  >
                    {node.expanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="size-4 shrink-0" aria-hidden />
                )}
                {node.icon ? (
                  <span className="flex size-4 shrink-0 items-center justify-center text-primary [&_svg]:size-4">
                    {node.icon}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-medium",
                    node.muted ? "text-muted-foreground" : "",
                  )}
                >
                  {node.label}
                </span>
                {node.trailing ? (
                  <div
                    className="flex shrink-0 items-center gap-1"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {node.trailing}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
