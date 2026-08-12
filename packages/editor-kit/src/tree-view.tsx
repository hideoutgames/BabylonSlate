import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { CONTEXT_MENU_LONG_PRESS_MS, CONTEXT_MENU_MOVE_TOLERANCE_PX } from "./use-context-menu";

/** Row height matches the touch-target floor so every row is a valid target. */
export const TREE_ROW_HEIGHT = 44;

export interface TreeViewNode {
  id: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Trailing controls such as visibility and lock toggles. */
  trailing?: ReactNode;
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
  onContextMenu?: (id: string, clientX: number, clientY: number) => void;
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
  onContextMenu,
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

  const measure = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    if (element) {
      setViewportHeight(element.clientHeight);
    }
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

  const clearDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.longPressTimer) clearTimeout(drag.longPressTimer);
    dragRef.current = null;
    setDropTargetId(undefined);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, nodeId: string) => {
      const longPressTimer = onContextMenu
        ? setTimeout(() => {
            const drag = dragRef.current;
            if (!drag || drag.armed) return;
            dragRef.current = null;
            onContextMenu(nodeId, event.clientX, event.clientY);
          }, CONTEXT_MENU_LONG_PRESS_MS)
        : null;
      dragRef.current = {
        pointerId: event.pointerId,
        nodeId,
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        longPressTimer,
      };
    },
    [onContextMenu],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY,
      );
      if (!drag.armed && moved > CONTEXT_MENU_MOVE_TOLERANCE_PX) {
        drag.armed = true;
        if (drag.longPressTimer) clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
      if (!drag.armed || !onReparent) return;
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
      } else if (!drag.armed) {
        onSelect?.(drag.nodeId);
      }
      clearDrag();
    },
    [clearDrag, nodeIdAtClientY, onReparent, onSelect],
  );

  return (
    <div
      ref={measure}
      className="h-full min-h-0 overflow-auto"
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
                data-drop-target={dropTargetId === node.id ? "true" : undefined}
                className={`absolute right-0 left-0 flex touch-none items-center gap-1 px-1 text-sm ${
                  selected ? "bg-accent font-medium" : "hover:bg-accent/50"
                } ${dropTargetId === node.id ? "outline outline-1 outline-ring" : ""}`}
                style={{
                  top,
                  height: rowHeight,
                  paddingLeft: `${node.depth * 12 + 4}px`,
                }}
                onPointerDown={(event) => onPointerDown(event, node.id)}
                onContextMenu={(event) => {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  onContextMenu(node.id, event.clientX, event.clientY);
                }}
              >
                <button
                  type="button"
                  aria-label={
                    node.hasChildren
                      ? `${node.expanded ? "Collapse" : "Expand"} ${node.label}`
                      : undefined
                  }
                  className="flex h-11 w-8 shrink-0 items-center justify-center text-muted-foreground"
                  disabled={!node.hasChildren}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleExpanded?.(node.id);
                  }}
                  data-testid={`tree-disclosure-${node.id}`}
                >
                  {node.hasChildren ? (node.expanded ? "▾" : "▸") : ""}
                </button>
                <span
                  className={`min-w-0 flex-1 truncate ${node.muted ? "text-muted-foreground" : ""}`}
                >
                  {node.label}
                </span>
                {node.trailing ? (
                  <div className="flex shrink-0 items-center gap-1">
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
