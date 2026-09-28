import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { useCallback, useMemo, useRef, type MouseEvent } from "react";
import {
  Columns3Icon,
  ListOrderedIcon,
  PlayIcon,
  SplitIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ContextMenuOverlay,
  humanizePropertyLabel,
  useContextMenu,
  type NestedMenuItem,
} from "@babylonslate/editor-kit";
import { cn } from "@babylonslate/ui/lib/utils";
import { BlueprintNodeShell, type CanvasNode } from "./graph-nodes";
import { useGraphEditorContext } from "./graph-editor-context";
import { nodeRoleClass, type NodeVisualRole } from "./node-theme";

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

const KIND_ICON: Record<string, LucideIcon> = {
  selector: SplitIcon,
  sequence: ListOrderedIcon,
  parallel: Columns3Icon,
  task: PlayIcon,
};

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
        "bt-pin !flex !size-6 !min-h-6 !min-w-6 items-center justify-center rounded-full",
        "pointer-coarse:!size-11 pointer-coarse:!min-h-11 pointer-coarse:!min-w-11",
        "!border-0 !bg-transparent touch-manipulation",
        pending && "ring-2 ring-primary",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onPinTap(nodeId, pinId, direction);
      }}
    >
      <span
        className="graph-pin-visual bt-pin-visual block size-2.5 rotate-45 rounded-[2px] border-[1.5px]"
        data-pin-shape="diamond"
        data-pin-connected={connected ? "true" : "false"}
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

  const role = treeRole(kind, protectedNode);
  const KindIcon = KIND_ICON[kind] ?? PlayIcon;
  const kindLabel = protectedNode
    ? `Root ${humanizePropertyLabel(kind)}`
    : humanizePropertyLabel(kind);
  const stateLabel = running
    ? "Running"
    : lastResult
      ? humanizePropertyLabel(lastResult)
      : "";

  return (
    <BlueprintNodeShell
      nodeId={id}
      title={title}
      role={role}
      selected={selected}
      data={data}
      card
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
        className="bt-node-drag-handle flex h-12 w-full items-center gap-2.5 px-2.5 text-left"
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
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-node-title",
            nodeRoleClass(role),
          )}
          aria-hidden="true"
        >
          <KindIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium leading-5 text-foreground" title={title}>
            {title}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
            <span className="truncate">{kindLabel}</span>
            <span
              className="bt-state flex shrink-0 items-center gap-1"
              data-testid={`bt-result-${id}`}
              data-state={state}
              aria-live="polite"
            >
              {stateLabel ? (
                <>
                  <span
                    className={cn(
                      "bt-state-dot size-1.5 rounded-full",
                      running && "motion-safe:animate-pulse",
                    )}
                    aria-hidden="true"
                  />
                  {stateLabel}
                </>
              ) : null}
            </span>
          </span>
        </span>
        <span
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground"
          title="Priority"
          data-testid={`bt-sort-${id}`}
        >
          {sortIndex}
        </span>
      </button>
      {decorators.length + services.length > 0 ? (
        <div className="flex flex-col border-t border-border py-1">
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
        </div>
      ) : null}
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
          "nodrag nopan flex min-h-7 w-full items-center gap-2 px-2.5 text-left text-xs pointer-coarse:min-h-11",
          "hover:bg-accent/50",
          selected && "bg-accent hover:bg-accent",
        )}
        data-testid={testId}
        data-selected={selected ? "true" : "false"}
        onClick={onClick}
        {...menu.bind}
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            tone === "decorator" ? "bg-node-bt-decorator" : "bg-node-bt-service",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-foreground" title={label}>{label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{prefix}</span>
      </button>
      <ContextMenuOverlay menu={menu.menu} onClose={menu.closeMenu} />
    </>
  );
}

export const treeNodeTypes = {
  "bt.node": TreeNode,
};
