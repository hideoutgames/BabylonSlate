import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useCallback, useRef, type MouseEvent } from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import { BlueprintNodeShell, type CanvasNode } from "./graph-nodes";
import { useGraphEditorContext } from "./graph-editor-context";

const DOUBLE_TAP_MS = 350;

type AttachedRow = { id: string; classId: string };

function asRows(value: unknown): AttachedRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is AttachedRow => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.classId === "string";
  });
}

export function TreeNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { onNavigateRequest, selectedAttachmentId, onAttachmentSelect } =
    useGraphEditorContext();
  const lastTap = useRef(0);
  const title = typeof data.title === "string" ? data.title : id;
  const kind = typeof data.kind === "string" ? data.kind : "task";
  const sortIndex = typeof data.sortIndex === "number" ? data.sortIndex : 0;
  const lastResult = typeof data.lastResult === "string" ? data.lastResult : null;
  const running = data.running === true;
  const decorators = asRows(data.decorators);
  const services = asRows(data.services);
  const showChildren = kind !== "task";

  const handleHeaderClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        onNavigateRequest?.({ nodeId: id });
      }
      lastTap.current = now;
    },
    [id, onNavigateRequest],
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
      >
        <span>{kind}</span>
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
          {running ? "running" : lastResult}
        </div>
      ) : null}
      {decorators.map((row) => (
        <button
          key={row.id}
          type="button"
          className={cn(
            "flex min-h-11 w-full items-center px-3 text-left text-xs",
            selectedAttachmentId === row.id && "bg-accent",
          )}
          data-testid={`bt-decorator-${row.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onAttachmentSelect?.(row.id);
          }}
        >
          Decorator · {row.classId}
        </button>
      ))}
      {services.map((row) => (
        <button
          key={row.id}
          type="button"
          className={cn(
            "flex min-h-11 w-full items-center px-3 text-left text-xs",
            selectedAttachmentId === row.id && "bg-accent",
          )}
          data-testid={`bt-service-${row.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onAttachmentSelect?.(row.id);
          }}
        >
          Service · {row.classId}
        </button>
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
    </BlueprintNodeShell>
  );
}

export const treeNodeTypes = {
  "bt.node": TreeNode,
};
