import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { treeGuideSegments } from "./tree-guides";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  CONTEXT_MENU_LONG_PRESS_MS,
  CONTEXT_MENU_MOVE_TOLERANCE_PX,
  DRAG_ARM_MS,
} from "./use-context-menu";
import { WINDOWED_SLICE_OVERSCAN, windowedSlice } from "./windowed-slice";

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
  /** Noninteractive value summary; pointer gestures still select the row. */
  preview?: ReactNode;
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
  onExternalDragMove?: (id: string, clientX: number, clientY: number) => void;
  onExternalDragEnd?: () => void;
  /** Double-tap / double-click a row (frame camera, open, …). */
  onActivate?: (id: string) => void;
  onContextMenu?: (id: string, clientX: number, clientY: number) => void;
  /** @deprecated Timing follows input: mouse drags immediately; touch/pen hold for 250ms. */
  reparentArm?: "immediate" | "hold";
  rowHeight?: number;
  emptyLabel?: string;
  "data-testid"?: string;
  "aria-label"?: string;
}

interface DragState {
  pointerId: number;
  pointerType: string;
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

function clearDragTimers(drag: DragState): void {
  if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
  if (drag.dragArmTimer) clearTimeout(drag.dragArmTimer);
  drag.longPressTimer = null;
  drag.dragArmTimer = null;
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
  rowHeight = TREE_ROW_HEIGHT,
  emptyLabel = "Nothing here yet",
  "data-testid": testId,
  "aria-label": accessibleName = "Tree",
}: TreeViewProps) {
  const treeId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const onExternalDragEndRef = useRef(onExternalDragEnd);
  onExternalDragEndRef.current = onExternalDragEnd;
  const extraPointerRef = useRef<ExtraPointer | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dropHint, setDropHint] = useState<DropHint | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = Math.max(
    0,
    nodes.findIndex((node) => node.id === (activeId ?? selectedId)),
  );
  const activeNode = nodes[activeIndex];
  const rowId = (id: string) => `${treeId}-${encodeURIComponent(id)}`;
  const hierarchy = useMemo(() => {
    const parents: string[] = [];
    const counts = new Map<string, number>();
    const positions = nodes.map((node) => {
      const parent = parents[node.depth - 1] ?? "";
      parents[node.depth] = node.id;
      parents.length = node.depth + 1;
      const position = (counts.get(parent) ?? 0) + 1;
      counts.set(parent, position);
      return { parent, position };
    });
    return positions.map((entry) => ({
      ...entry,
      size: counts.get(entry.parent),
    }));
  }, [nodes]);
  const selectedSet = new Set(
    selectedIds ??
      (selectedId !== null && selectedId !== undefined ? [selectedId] : []),
  );

  // jsdom and first paint report a zero-height client rect; render everything
  // rather than nothing so tests and the first frame both see real rows.
  const { firstIndex, lastIndex } = windowedSlice({
    itemCount: nodes.length,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: WINDOWED_SLICE_OVERSCAN,
  });
  const visibleIndexes = Array.from(
    { length: Math.max(0, lastIndex - firstIndex) },
    (_, i) => firstIndex + i,
  );
  if (activeNode && !visibleIndexes.includes(activeIndex)) {
    visibleIndexes.push(activeIndex);
    visibleIndexes.sort((a, b) => a - b);
  }

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(element.clientHeight),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (
      !element ||
      document.activeElement !== element ||
      !activeNode ||
      viewportHeight <= 0
    )
      return;
    const top = activeIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + viewportHeight) {
      element.scrollTop = top + rowHeight - viewportHeight;
    }
    setScrollTop(element.scrollTop);
  }, [activeIndex, activeNode, rowHeight, viewportHeight]);
  const guides = useMemo(() => treeGuideSegments(nodes), [nodes]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.nativeEvent.isComposing ||
      !activeNode
    )
      return;
    const select = (index: number) => {
      const node = nodes[index];
      if (!node) return;
      setActiveId(node.id);
      const container = containerRef.current;
      if (container && container.clientHeight > 0) {
        const top = index * rowHeight;
        if (top < container.scrollTop) container.scrollTop = top;
        else if (top + rowHeight > container.scrollTop + container.clientHeight)
          container.scrollTop = top + rowHeight - container.clientHeight;
        setScrollTop(container.scrollTop);
      }
      if (event.shiftKey) onSelect?.(node.id, { range: true });
      else if (!event.ctrlKey && !event.metaKey) onSelect?.(node.id);
    };
    if (event.key === "ArrowDown")
      select(Math.min(nodes.length - 1, activeIndex + 1));
    else if (event.key === "ArrowUp") select(Math.max(0, activeIndex - 1));
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(nodes.length - 1);
    else if (event.key === "ArrowRight") {
      const child = nodes[activeIndex + 1];
      if (activeNode.hasChildren && !activeNode.expanded)
        onToggleExpanded?.(activeNode.id);
      else if (child && child.depth > activeNode.depth) select(activeIndex + 1);
    } else if (event.key === "ArrowLeft") {
      if (activeNode.hasChildren && activeNode.expanded)
        onToggleExpanded?.(activeNode.id);
      else {
        for (let index = activeIndex - 1; index >= 0; index--) {
          if (nodes[index]!.depth < activeNode.depth) {
            select(index);
            break;
          }
        }
      }
    } else if (event.key === "Enter") {
      onSelect?.(activeNode.id);
      onActivate?.(activeNode.id);
    } else if (event.key === " ") {
      onSelect?.(activeNode.id, {
        additive: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
      });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

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
    dragRef.current = null;
    extraPointerRef.current = null;
    if (drag) clearDragTimers(drag);
    if (drag && containerRef.current?.hasPointerCapture?.(drag.pointerId)) {
      try {
        containerRef.current.releasePointerCapture(drag.pointerId);
      } catch {
        /* jsdom and detached nodes */
      }
    }
    setDropHint(undefined);
    if (drag?.armed) onExternalDragEndRef.current?.();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerType !== "touch") return;
      if (event.touches.length !== 1 || extraPointerRef.current) {
        if (drag.armed) clearDrag();
        else {
          clearDragTimers(drag);
          drag.canDrag = false;
        }
        return;
      }
      if (!drag.canDrag) {
        const touch = event.touches[0]!;
        if (
          Math.hypot(touch.clientX - drag.startX, touch.clientY - drag.startY) >
          CONTEXT_MENU_MOVE_TOLERANCE_PX
        ) {
          drag.moved = true;
          clearDragTimers(drag);
        }
        return;
      }
      // Pointer capture cannot stop native iOS panning. Cancel the first
      // touchmove after the hold, including movement below the drag threshold.
      // Changing touch-action after touchstart would not affect this gesture.
      if (event.cancelable) event.preventDefault();
      else clearDrag();
    };
    const onOtherPointer = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId === event.pointerId) return;
      if (drag.armed || !element.contains(event.target as Node)) clearDrag();
      else {
        clearDragTimers(drag);
        drag.canDrag = false;
      }
    };
    const onOutsideRelease = (event: PointerEvent) => {
      if (
        event.pointerId === dragRef.current?.pointerId &&
        !element.contains(event.target as Node)
      )
        clearDrag();
    };
    const onVisibilityChange = () => {
      if (document.hidden) clearDrag();
    };
    // Keep this listener installed before touchstart; a late listener can miss
    // WebKit's decision to allow synchronous cancellation of native scrolling.
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("pointerdown", onOtherPointer, true);
    document.addEventListener("pointerup", onOutsideRelease);
    document.addEventListener("pointercancel", onOutsideRelease);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", clearDrag);
    return () => {
      element.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("pointerdown", onOtherPointer, true);
      document.removeEventListener("pointerup", onOutsideRelease);
      document.removeEventListener("pointercancel", onOutsideRelease);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", clearDrag);
      clearDrag();
    };
  }, [clearDrag]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
      if (event.button !== 0) return;
      const existing = dragRef.current;
      if (!existing && event.isPrimary === false) return;
      if (existing && existing.pointerId !== event.pointerId) {
        extraPointerRef.current = {
          pointerId: event.pointerId,
          nodeId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        clearDragTimers(existing);
        existing.canDrag = false;
        return;
      }
      clearDrag();
      const longPressTimer =
        onContextMenu && event.pointerType !== "mouse"
          ? setTimeout(() => {
              const drag = dragRef.current;
              if (
                !drag ||
                drag.armed ||
                drag.moved ||
                extraPointerRef.current
              ) {
                return;
              }
              clearDrag();
              onContextMenu(nodeId, event.clientX, event.clientY);
            }, CONTEXT_MENU_LONG_PRESS_MS)
          : null;
      const canDragNow =
        Boolean(onReparent || onExternalDrop) && event.pointerType === "mouse";
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
        pointerType: event.pointerType,
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
    [clearDrag, onContextMenu, onExternalDrop, onReparent],
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
      if (
        drag.pointerType === "touch" &&
        !drag.canDrag &&
        !drag.armed &&
        inside &&
        isTreeSwipeAdd(dx, dy) &&
        !onExternalDrop
      ) {
        drag.swipeAdd = true;
        drag.canDrag = false;
        drag.armed = false;
        clearDragTimers(drag);
        setDropHint(undefined);
        return;
      }
      if (extraPointerRef.current) {
        clearDragTimers(drag);
        return;
      }
      if (!drag.canDrag) {
        clearDragTimers(drag);
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
      role="tree"
      aria-label={accessibleName}
      aria-multiselectable={selectedIds ? true : undefined}
      aria-activedescendant={activeNode ? rowId(activeNode.id) : undefined}
      tabIndex={0}
      className="group/tree text-foreground h-full min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid={testId}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
        if (dragRef.current) clearDrag();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={clearDrag}
      onLostPointerCapture={(event) => {
        if (
          event.target === event.currentTarget &&
          event.pointerId === dragRef.current?.pointerId
        )
          clearDrag();
      }}
    >
      {nodes.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div style={{ height: nodes.length * rowHeight, position: "relative" }}>
          {visibleIndexes.map((index) => {
            const node = nodes[index]!;
            const top = index * rowHeight;
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
                id={rowId(node.id)}
                aria-labelledby={`${rowId(node.id)}-label${node.preview ? ` ${rowId(node.id)}-preview` : ""}`}
                aria-posinset={hierarchy[index]?.position}
                aria-setsize={hierarchy[index]?.size}
                role="treeitem"
                aria-level={node.depth + 1}
                aria-selected={selected}
                aria-expanded={node.hasChildren ? node.expanded : undefined}
                data-testid={`tree-row-${node.id}`}
                data-depth={node.depth}
                data-drop-target={dropInto ? "true" : undefined}
                data-drop-before={dropBefore ? "true" : undefined}
                data-drop-after={dropAfter ? "true" : undefined}
                className={cn(
                  "group/tree-row absolute right-1 left-1 flex items-center gap-1 rounded-sm pr-1 text-[13px] transition-colors motion-reduce:transition-none",
                  selected
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                  dropInto
                    ? "bg-accent/50 outline outline-1 -outline-offset-1 outline-ring"
                    : "",
                  index === activeIndex &&
                    "group-focus-visible/tree:outline group-focus-visible/tree:outline-1 group-focus-visible/tree:outline-inset group-focus-visible/tree:outline-ring",
                )}
                style={{
                  top,
                  height: rowHeight,
                  paddingLeft: `${insertLeft}px`,
                }}
                onPointerDown={(event) => {
                  setActiveId(node.id);
                  if (event.pointerType === "mouse")
                    containerRef.current?.focus({ preventScroll: true });
                  onPointerDown(event, node.id);
                }}
                onContextMenu={(event) => {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  clearDrag();
                  onContextMenu(node.id, event.clientX, event.clientY);
                }}
              >
                {guides[index]!.map((segment, level) =>
                  segment ? (
                    <span
                      key={level}
                      aria-hidden
                      className="pointer-events-none absolute top-0 w-px bg-border/70"
                      style={{
                        left: level * 16 + (rowHeight >= 44 ? 30 : 18),
                        height: segment === "end" ? "50%" : "100%",
                      }}
                    />
                  ) : null,
                )}
                {!node.hasChildren && node.depth > 0 ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 h-px bg-border/70"
                    style={{
                      left: (node.depth - 1) * 16 + (rowHeight >= 44 ? 30 : 18),
                      width: 8,
                    }}
                  />
                ) : null}
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
                    tabIndex={-1}
                    aria-label={`${node.expanded ? "Collapse" : "Expand"} ${node.label}`}
                    className={cn(
                      "relative flex shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                      rowHeight >= 44 ? "size-11" : "size-5",
                    )}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveId(node.id);
                      containerRef.current?.focus({ preventScroll: true });
                      onToggleExpanded?.(node.id);
                    }}
                    data-testid={`tree-disclosure-${node.id}`}
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(
                        "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                        node.expanded && "rotate-90",
                      )}
                    />
                  </button>
                ) : (
                  <span
                    className={cn(
                      "shrink-0",
                      rowHeight >= 44 ? "size-11" : "size-5",
                    )}
                    aria-hidden
                  />
                )}
                {node.icon ? (
                  <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                    {node.icon}
                  </span>
                ) : null}
                <span
                  id={`${rowId(node.id)}-label`}
                  className={cn(
                    "relative min-w-0 flex-1 truncate",
                    selected ? "font-medium" : "font-normal",
                    node.muted ? "text-muted-foreground" : "",
                  )}
                >
                  {node.label}
                </span>
                {node.preview ? (
                  <span
                    id={`${rowId(node.id)}-preview`}
                    className="min-w-0 shrink"
                  >
                    {node.preview}
                  </span>
                ) : null}
                {node.trailing ? (
                  <div
                    className="relative flex shrink-0 items-center gap-1 text-muted-foreground group-hover/tree-row:text-foreground group-focus-within/tree-row:text-foreground"
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
