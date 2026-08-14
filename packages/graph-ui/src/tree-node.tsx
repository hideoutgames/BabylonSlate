import { Handle, Position, type NodeProps } from "@xyflow/react";
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
  const decorators = asRows(data.decorators);
  const services = asRows(data.services);
  const showChildren = kind !== "task";
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
      role={kind === "task" ? "function" : "flow"}
      selected={selected}
    >
      <Handle
        id="parent"
        type="target"
        position={Position.Top}
        className="!size-11 !min-h-11 !min-w-11 !border-0 !bg-transparent"
        aria-label="Parent"
      />
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-1 text-left text-xs text-muted-foreground"
        data-testid={`bt-node-${id}`}
        data-running={running ? "true" : "false"}
        data-last-result={lastResult ?? ""}
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
        <span data-testid={`bt-sort-${id}`}>#{sortIndex}</span>
      </button>
      {lastResult || running ? (
        <div
          className={cn(
            "px-3 py-1 text-xs",
            running && "bg-primary/20 text-primary",
            lastResult === "success" && "text-emerald-500",
            lastResult === "failure" && "text-destructive",
          )}
          data-testid={`bt-result-${id}`}
        >
          {running ? "Running" : humanizePropertyLabel(lastResult ?? "")}
        </div>
      ) : null}
      {decorators.map((row) => (
        <AttachmentRow
          key={row.id}
          prefix="Decorator"
          testId={`bt-decorator-${row.id}`}
          label={attachmentTitle(row)}
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
          selected={selectedAttachmentId === row.id}
          items={contextMenuItemsForAttachment?.(id, row.id) ?? []}
          onClick={(event) => handleAttachmentClick(event, row.id)}
        />
      ))}
      {showChildren ? (
        <Handle
          id="children"
          type="source"
          position={Position.Bottom}
          className="!size-11 !min-h-11 !min-w-11 !border-0 !bg-transparent"
          aria-label="Children"
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
  selected,
  items,
  onClick,
}: {
  prefix: string;
  testId: string;
  label: string;
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
          "flex min-h-11 w-full items-center px-3 text-left text-xs",
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
