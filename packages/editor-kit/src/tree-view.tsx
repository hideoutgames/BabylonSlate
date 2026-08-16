import {
  useCallback,
  useEffect,
  useLayoutEffect,
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

// #region agent log
let agentWheelN = 0;
let agentTouchN = 0;
let agentMoveN = 0;
function agentDbg(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void {
  const payload = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    hypothesisId,
    location,
    message,
    data,
  };
  console.debug("[agent-dbg]", payload);
  if (typeof fetch === "function") {
    void fetch("/__agent_debug_log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `${JSON.stringify(payload)}\n`,
      keepalive: true,
    }).catch(() => {});
  }
}
function agentBox(el: Element | null): Record<string, unknown> | null {
  if (!el || !(el instanceof HTMLElement)) return null;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    offsetHeight: el.offsetHeight,
    scrollTop: el.scrollTop,
    overflowY: s.overflowY,
    height: s.height,
    minHeight: s.minHeight,
    flexGrow: s.flexGrow,
    flexBasis: s.flexBasis,
    rectTop: Math.round(r.top),
    rectBottom: Math.round(r.bottom),
    rectHeight: Math.round(r.height),
  };
}
// #endregion

/** Row height matches `--chrome-row` (28px). */
export const TREE_ROW_HEIGHT = 28;

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
  onSelect?: (id: string) => void;
  onToggleExpanded?: (id: string) => void;
  /** Drop `dragId` onto `targetId`; null means the scene root. */
  onReparent?: (dragId: string, targetId: string | null) => void;
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
  dragArmTimer: ReturnType<typeof setTimeout> | null;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Virtualized touch tree. Rows are fixed height so the visible window is
 * arithmetic rather than measurement, which keeps scrolling allocation-free.
 */
export function TreeView({
  nodes,
  selectedId = null,
  onSelect,
  onToggleExpanded,
  onReparent,
  onActivate,
  onContextMenu,
  reparentArm = "hold",
  rowHeight = TREE_ROW_HEIGHT,
  emptyLabel = "Nothing here yet",
  "data-testid": testId,
}: TreeViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dropTargetId, setDropTargetId] = useState<string | null | undefined>(
    undefined,
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

  const viewportHeightRef = useRef(0);
  viewportHeightRef.current = viewportHeight;

  const measure = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element) {
      setViewportHeight(element.clientHeight);
      // #region agent log
      agentDbg("B", "tree-view.tsx:measure", "ref measure", {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        offsetHeight: element.offsetHeight,
        box: agentBox(element),
        nodeCountHint: "pending",
      });
      // #endregion
    }
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const content = el?.firstElementChild;
    const contentH =
      content instanceof HTMLElement ? content.offsetHeight : null;
    // #region agent log
    agentDbg("A", "tree-view.tsx:layout", "after layout", {
      viewportHeight,
      windowed,
      nodeCount: nodes.length,
      visibleCount: visible.length,
      contentHeightCss: nodes.length * rowHeight,
      contentOffsetHeight: contentH,
      tree: agentBox(el),
      heightMismatch:
        el != null && el.scrollHeight > el.clientHeight + 1,
      viewportVsClient: {
        state: viewportHeight,
        client: el?.clientHeight ?? null,
        zeroViewport: viewportHeight === 0,
      },
    });
    // #endregion
  }, [nodes.length, rowHeight, viewportHeight, visible.length, windowed]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        // #region agent log
        agentDbg("C", "tree-view.tsx:resize", "container resize", {
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          viewportHeightState: viewportHeightRef.current,
          observerUpdatesState: false,
        });
        // #endregion
      });
      ro.observe(el);
    }
    const onWheel = (event: WheelEvent) => {
      if (agentWheelN > 12) return;
      agentWheelN += 1;
      const before = el.scrollTop;
      requestAnimationFrame(() => {
        // #region agent log
        agentDbg("D", "tree-view.tsx:wheel", "wheel", {
          n: agentWheelN,
          deltaY: event.deltaY,
          defaultPrevented: event.defaultPrevented,
          cancelable: event.cancelable,
          scrollTopBefore: before,
          scrollTopAfter: el.scrollTop,
          captured: dragRef.current
            ? el.hasPointerCapture?.(dragRef.current.pointerId)
            : false,
          tree: agentBox(el),
        });
        // #endregion
      });
    };
    const onTouchMove = (event: TouchEvent) => {
      if (agentTouchN > 12) return;
      agentTouchN += 1;
      const before = el.scrollTop;
      requestAnimationFrame(() => {
        // #region agent log
        agentDbg("D", "tree-view.tsx:touchmove", "touchmove", {
          n: agentTouchN,
          defaultPrevented: event.defaultPrevented,
          cancelable: event.cancelable,
          scrollTopBefore: before,
          scrollTopAfter: el.scrollTop,
          captured: dragRef.current
            ? el.hasPointerCapture?.(dragRef.current.pointerId)
            : false,
        });
        // #endregion
      });
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  const nodeIdAtClientY = useCallback(
    (clientY: number): string | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const index = Math.floor(
        (clientY - rect.top + container.scrollTop) / rowHeight,
      );
      return nodes[index]?.id ?? null;
    },
    [nodes, rowHeight],
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
    dragRef.current = null;
    setDropTargetId(undefined);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
      const longPressTimer = onContextMenu
        ? setTimeout(() => {
            const drag = dragRef.current;
            if (!drag || drag.armed || drag.moved) return;
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
      const dragArmTimer =
        onReparent && reparentArm === "hold"
          ? setTimeout(() => {
              const drag = dragRef.current;
              if (!drag || drag.moved) return;
              drag.canDrag = true;
              try {
                containerRef.current?.setPointerCapture?.(drag.pointerId);
              } catch {
                /* jsdom and detached nodes */
              }
              // #region agent log
              agentDbg("D", "tree-view.tsx:hold-arm", "hold armed capture", {
                pointerId: drag.pointerId,
                captured:
                  containerRef.current?.hasPointerCapture?.(drag.pointerId) ??
                  false,
                canDrag: true,
                moved: drag.moved,
              });
              // #endregion
            }, DRAG_ARM_MS)
          : null;
      dragRef.current = {
        pointerId: event.pointerId,
        nodeId,
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        canDrag: Boolean(onReparent) && reparentArm === "immediate",
        moved: false,
        dragArmTimer,
        longPressTimer,
      };
      if (reparentArm !== "hold") {
        try {
          containerRef.current?.setPointerCapture?.(event.pointerId);
        } catch {
          /* jsdom and detached nodes */
        }
      }
      // #region agent log
      const row = event.currentTarget;
      agentDbg("D", "tree-view.tsx:pointerdown", "pointerdown", {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        captured: containerRef.current?.hasPointerCapture?.(event.pointerId) ?? false,
        rowTouchAction: getComputedStyle(row).touchAction,
        treeTouchAction: containerRef.current
          ? getComputedStyle(containerRef.current).touchAction
          : null,
        scrollTop: containerRef.current?.scrollTop ?? null,
        reparentArm,
        canDrag: Boolean(onReparent) && reparentArm === "immediate",
      });
      // #endregion
    },
    [onContextMenu, onReparent, reparentArm],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (moved <= CONTEXT_MENU_MOVE_TOLERANCE_PX) return;
      drag.moved = true;
      if (!drag.canDrag) {
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
        if (drag.dragArmTimer) clearTimeout(drag.dragArmTimer);
        drag.dragArmTimer = null;
        // #region agent log
        if (agentMoveN <= 12) {
          agentMoveN += 1;
          agentDbg("D", "tree-view.tsx:pointermove", "move before drag arm", {
            n: agentMoveN,
            moved,
            canDrag: false,
            defaultPrevented: event.nativeEvent.defaultPrevented,
            captured:
              containerRef.current?.hasPointerCapture?.(event.pointerId) ??
              false,
            scrollTop: containerRef.current?.scrollTop ?? null,
          });
        }
        // #endregion
        return;
      }
      if (!drag.armed) {
        drag.armed = true;
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
      if (!onReparent) return;
      const target = nodeIdAtClientY(event.clientY);
      setDropTargetId(target === drag.nodeId ? undefined : target);
    },
    [nodeIdAtClientY, onReparent],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        clearDrag();
        return;
      }
      if (drag.armed && onReparent) {
        const target = nodeIdAtClientY(event.clientY);
        if (target !== drag.nodeId) {
          onReparent(drag.nodeId, target);
        }
      } else if (!drag.armed && !drag.moved) {
        onSelect?.(drag.nodeId);
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
    [clearDrag, nodeIdAtClientY, onActivate, onReparent, onSelect],
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
            const selected = node.id === selectedId;
            return (
              <div
                key={node.id}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={node.hasChildren ? node.expanded : undefined}
                data-testid={`tree-row-${node.id}`}
                data-depth={node.depth}
                data-drop-target={dropTargetId === node.id ? "true" : undefined}
                className={cn(
                  "absolute right-0 left-0 flex items-center gap-1 border-l-2 px-1 text-sm",
                  selected
                    ? "border-l-primary bg-primary/20 font-medium"
                    : "border-l-transparent hover:bg-accent/50",
                  dropTargetId === node.id ? "outline outline-1 outline-ring" : "",
                )}
                style={{
                  top,
                  height: rowHeight,
                  paddingLeft: `${node.depth * 16 + 8}px`,
                }}
                onPointerDown={(event) => onPointerDown(event, node.id)}
                onContextMenu={(event) => {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  onContextMenu(node.id, event.clientX, event.clientY);
                }}
              >
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
