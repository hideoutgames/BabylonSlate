import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { useCallback, useMemo, useRef, type MouseEvent } from "react";
import {
  ContextMenuOverlay,
  humanizePropertyLabel,
  useContextMenu,
  type NestedMenuItem,
} from "@babylonslate/editor-kit";
import { cn } from "@babylonslate/ui/lib/utils";
import { BlueprintNodeShell, type CanvasNode } from "./graph-nodes";
import { useGraphEditorContext } from "./graph-editor-context";
import type { NodeVisualRole } from "./node-theme";

const DOUBLE_TAP_MS = 350;

type AttachedRow = { id: string; classId: string; title?: string };

function asRows(value: unknown): AttachedRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AttachedRow => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.classId === "string";
  });
}

function attachmentTitle(row: AttachedRow): string {
  if (typeof row.title === "string" && row.title !== "") return row.title;
  const last = row.classId.includes(".")
    ? row.classId.slice(row.classId.lastIndexOf(".") + 1)
    : row.classId;
  return humanizePropertyLabel(last);
}

function treeRole(
  kind: string,
  protectedNode: boolean,
): NodeVisualRole {
  if (protectedNode) return "bt-root";
  if (kind === "task") return "bt-task";
  return "bt-composite";
}

function treeState(running: boolean, lastResult: string | null): string {
  if (running) return "running";
  if (lastResult === "success" || lastResult === "failure") return lastResult;
  return "idle";
}

function TreePinHandle({
  nodeId,
  pinId,
  direction,
  position,
  label,
}: {
  nodeId: string;
  pinId: string;
  direction: "in" | "out";
  position: Position;
  label: string;
}) {
  const { onPinTap, pendingPin } = useGraphEditorContext();
  const pending = pendingPin?.nodeId === nodeId && pendingPin.pinId === pinId;
  const connected = useStore((state) =>
    state.edges.some((edge) =>
      direction === "out"
        ? edge.source === nodeId && (edge.sourceHandle ?? "") === pinId
        : edge.target === nodeId && (edge.targetHandle ?? "") === pinId,
    ),
  );

  return (
    <Handle
      id={pinId}
      type={direction === "out" ? "source" : "target"}
      position={position}
      aria-label={label}
      data-pin-type="exec"
      className={cn(
        "!flex !size-11 !min-h-11 !min-w-11 items-center justify-center",
        "!border-0 !bg-transparent touch-manipulation",
        pending && "ring-2 ring-primary ring-offset-1 ring-offset-card",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onPinTap(nodeId, pinId, direction);
      }}
    >
      <span
        className={cn(
          "graph-pin-visual block rotate-45 rounded-sm border-2",
          connected ? "border-card" : "",
        )}
        data-pin-shape="diamond"
        data-pin-connected={connected ? "true" : "false"}
        style={{
          width: "var(--graph-pin-size, 22px)",
          height: "var(--graph-pin-size, 22px)",
          background: connected ? "var(--pin-exec)" : "transparent",
          borderColor: connected ? undefined : "var(--pin-exec)",
        }}
        aria-hidden="true"
      />
    </Handle>
  );
}

export function TreeNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const {
    onNavigateRequest,
    selectedAttachmentId,
    onAttachmentSelect,
    onAttachmentDoubleClick,
    contextMenuItemsForNode,
    contextMenuItemsForAttachment,
  } = useGraphEditorContext();
  const lastTap = useRef(0);
  const lastAttachmentTap = useRef({ id: "", at: 0 });
  const title = typeof data.title === "string" ? data.title : id;
  const kind = typeof data.kind === "string" ? data.kind : "task";
  const sortIndex = typeof data.sortIndex === "number" ? data.sortIndex : 0;
  const lastResult = typeof data.lastResult === "string" ? data.lastResult : null;
  const running = data.running === true;
  const protectedNode = data.__protected === true;
  const decorators = asRows(data.decorators);
  const services = asRows(data.services);
  const showChildren = kind !== "task";
  const state = treeState(running, lastResult);
  const nodeMenuItems = useMemo(
    () => contextMenuItemsForNode?.(id) ?? [],
    [contextMenuItemsForNode, id],
  );
  const nodeMenu = useContextMenu({ items: nodeMenuItems, enabled: nodeMenuItems.length > 0 });

  const handleHeaderClick = useCallback(
    (event: MouseEvent) => {
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        event.stopPropagation();
        onNavigateRequest?.({ nodeId: id });
      }
      lastTap.current = now;
    },
    [id, onNavigateRequest],
  );

  const handleAttachmentClick = useCallback(
    (event: MouseEvent, attachmentId: string) => {
      event.stopPropagation();
      const now = Date.now();
      const prev = lastAttachmentTap.current;
      if (prev.id === attachmentId && now - prev.at < DOUBLE_TAP_MS) {
        onAttachmentDoubleClick?.(id, attachmentId);
      }
      lastAttachmentTap.current = { id: attachmentId, at: now };
      onAttachmentSelect?.(attachmentId);
    },
    [id, onAttachmentDoubleClick, onAttachmentSelect],
  );

  return (
    <BlueprintNodeShell
      nodeId={id}
      title={title}
      role={treeRole(kind, protectedNode)}
      selected={selected}
      data={data}
      compact
    >
      {protectedNode ? null : (
        <TreePinHandle
          nodeId={id}
          pinId="parent"
          direction="in"
          position={Position.Top}
          label="Parent"
        />
      )}
      <button
        type="button"
        className="bt-node-drag-handle flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs text-muted-foreground"
        data-testid={`bt-node-${id}`}
        data-running={running ? "true" : "false"}
        data-last-result={lastResult ?? ""}
        data-bt-state={state}
        aria-label={`${title}, ${humanizePropertyLabel(kind)}, priority ${sortIndex}, ${state}`}
        onClick={handleHeaderClick}
        onContextMenu={(event) => {
          event.stopPropagation();
          nodeMenu.bind.onContextMenu(event);
        }}
        onPointerDown={nodeMenu.bind.onPointerDown}
        onPointerMove={nodeMenu.bind.onPointerMove}
        onPointerUp={nodeMenu.bind.onPointerUp}
        onPointerCancel={nodeMenu.bind.onPointerCancel}
      >
        <span>{humanizePropertyLabel(kind)}</span>
        <span
          className="flex size-5 items-center justify-center rounded-full bg-background text-[10px] font-semibold text-foreground"
          data-testid={`bt-sort-${id}`}
        >
          {sortIndex}
        </span>
      </button>
      <div
        className="min-h-5 px-3 text-xs leading-5"
        data-testid={`bt-result-${id}`}
        aria-live="polite"
      >
        {running
          ? "Running"
          : lastResult
            ? humanizePropertyLabel(lastResult)
            : "\u00a0"}
      </div>
      {decorators.map((row) => (
        <AttachmentRow
          key={row.id}
          prefix="Decorator"
          testId={`bt-decorator-${row.id}`}
          label={attachmentTitle(row)}
          tone="decorator"
          selected={selectedAttachmentId === row.id}
          items={contextMenuItemsForAttachment?.(id, row.id) ?? []}
          onClick={(event) => handleAttachmentClick(event, row.id)}
        />
      ))}
      {services.map((row) => (
        <AttachmentRow
          key={row.id}
          prefix="Service"
          testId={`bt-service-${row.id}`}
          label={attachmentTitle(row)}
          tone="service"
          selected={selectedAttachmentId === row.id}
          items={contextMenuItemsForAttachment?.(id, row.id) ?? []}
          onClick={(event) => handleAttachmentClick(event, row.id)}
        />
      ))}
      {showChildren ? (
        <TreePinHandle
          nodeId={id}
          pinId="children"
          direction="out"
          position={Position.Bottom}
          label="Children"
        />
      ) : null}
      <ContextMenuOverlay menu={nodeMenu.menu} onClose={nodeMenu.closeMenu} />
    </BlueprintNodeShell>
  );
}

function AttachmentRow({
  prefix,
  testId,
  label,
  tone,
  selected,
  items,
  onClick,
}: {
  prefix: string;
  testId: string;
  label: string;
  tone: "decorator" | "service";
  selected: boolean;
  items: NestedMenuItem[];
  onClick: (event: MouseEvent) => void;
}) {
  const menu = useContextMenu({ items, enabled: items.length > 0 });
  return (
    <>
      <button
        type="button"
        className={cn(
          "nodrag nopan flex min-h-11 w-full items-center px-3 text-left text-xs",
          tone === "decorator" ? "bg-node-bt-decorator/20" : "bg-node-bt-service/20",
          selected && "bg-accent",
        )}
        data-testid={testId}
        onClick={onClick}
        {...menu.bind}
      >
        {prefix} · {label}
      </button>
      <ContextMenuOverlay menu={menu.menu} onClose={menu.closeMenu} />
    </>
  );
}

export const treeNodeTypes = {
  "bt.node": TreeNode,
};
