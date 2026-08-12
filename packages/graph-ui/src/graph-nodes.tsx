import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, type MouseEvent } from "react";
import { useGraphEditorContext } from "./graph-editor-context";
import { hasSerializedPins, type SerializedPin } from "./graph-types";

type LogNodeData = {
  message: string;
};

export type CanvasNode = Node<Record<string, unknown>>;

function pinHandleClass(pin: SerializedPin, selected: boolean): string {
  const base =
    "h-3! w-3! min-h-3 min-w-3 border-2 border-background touch-manipulation";
  const selectedRing = selected ? " ring-2 ring-primary ring-offset-1" : "";
  if (pin.kind === "exec") {
    return `${base} rounded-sm bg-muted-foreground${selectedRing}`;
  }
  return `${base} rounded-full bg-primary${selectedRing}`;
}

function PinHandles({
  nodeId,
  pins,
}: {
  nodeId: string;
  pins: SerializedPin[];
}) {
  const { pendingPin, onPinTap, pinHasError } = useGraphEditorContext();

  const inPins = pins.filter((pin) => pin.direction === "in");
  const outPins = pins.filter((pin) => pin.direction === "out");

  const renderHandle = (pin: SerializedPin, index: number, total: number) => {
    const isSource = pin.direction === "out";
    const topPct = total <= 1 ? 50 : ((index + 1) / (total + 1)) * 100;
    const isPending =
      pendingPin?.nodeId === nodeId && pendingPin.pinId === pin.id;
    const hasError = pinHasError(nodeId, pin.id);

    return (
      <Handle
        key={pin.id}
        id={pin.id}
        type={isSource ? "source" : "target"}
        position={isSource ? Position.Right : Position.Left}
        className={pinHandleClass(pin, isPending)}
        style={{ top: `${topPct}%` }}
        aria-label={pin.name}
        onClick={(event) => {
          event.stopPropagation();
          onPinTap(nodeId, pin.id, pin.direction);
        }}
        data-error={hasError ? "true" : undefined}
      />
    );
  };

  return (
    <>
      {inPins.map((pin, index) => renderHandle(pin, index, inPins.length))}
      {outPins.map((pin, index) => renderHandle(pin, index, outPins.length))}
    </>
  );
}

function NodeErrorBadge({
  nodeId,
  count,
}: {
  nodeId: string;
  count: number;
}) {
  const { onNavigateRequest } = useGraphEditorContext();

  const handleClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      onNavigateRequest?.({ nodeId });
    },
    [nodeId, onNavigateRequest],
  );

  if (count <= 0) return null;

  return (
    <button
      type="button"
      className="absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
      aria-label={`${count} error${count === 1 ? "" : "s"}`}
      onClick={handleClick}
    >
      {count > 9 ? "9+" : count}
    </button>
  );
}

export function PinNode({ id, data, type }: NodeProps<CanvasNode>) {
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { nodeErrorCount } = useGraphEditorContext();
  const title =
    typeof data.title === "string"
      ? data.title
      : String(data.__nodeType ?? type ?? "Node").replace(/\./g, " ");

  return (
    <div className="relative min-w-44 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm">
      <NodeErrorBadge nodeId={id} count={nodeErrorCount(id)} />
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-1">
        {pins
          .filter((pin) => pin.direction === "in")
          .map((pin) => (
            <div
              key={pin.id}
              className="pl-3 text-xs text-muted-foreground"
            >
              {pin.name}
            </div>
          ))}
        {pins
          .filter((pin) => pin.direction === "out")
          .map((pin) => (
            <div
              key={pin.id}
              className="pr-3 text-right text-xs text-muted-foreground"
            >
              {pin.name}
            </div>
          ))}
      </div>
      <PinHandles nodeId={id} pins={pins} />
    </div>
  );
}

export function LogMessageNode({ id, data }: NodeProps<Node<LogNodeData>>) {
  const { nodeErrorCount } = useGraphEditorContext();

  return (
    <div className="relative flex min-h-11 min-w-44 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm">
      <NodeErrorBadge nodeId={id} count={nodeErrorCount(id)} />
      <div className="text-xs font-medium text-muted-foreground">Log Message</div>
      <div className="text-sm">{data.message}</div>
    </div>
  );
}

export function resolveNodeType(
  type: string,
  data: Record<string, unknown>,
): string {
  if (type === "logMessage" && !hasSerializedPins(data)) {
    return "logMessage";
  }
  return "pinNode";
}

export const graphNodeTypes = {
  logMessage: LogMessageNode,
  pinNode: PinNode,
};
