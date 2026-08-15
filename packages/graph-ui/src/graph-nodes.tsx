import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import { humanizePropertyLabel } from "@babylonslate/editor-kit";
import { isDevelopmentOnlyNode } from "@babylonslate/scripting";
import { cn } from "@babylonslate/ui/lib/utils";
import { useGraphEditorContext } from "./graph-editor-context";
import { hasSerializedPins, type SerializedPin } from "./graph-types";
import { displayNodeTitle } from "./graph-connect";
import {
  nodeRoleClass,
  nodeVisualRole,
  pinCssVar,
  pinVisualShape,
  type NodeVisualRole,
  type PinTypeRef,
} from "./node-theme";

type LogNodeData = {
  message: string;
};

export type CanvasNode = Node<Record<string, unknown>>;

function visualFromData(
  data: Record<string, unknown>,
  type: string | undefined,
): {
  title: string;
  role: NodeVisualRole;
} {
  const nodeType =
    typeof data.__nodeType === "string" ? data.__nodeType : (type ?? "Node");
  const title = displayNodeTitle(
    nodeType,
    typeof data.title === "string" ? data.title : undefined,
  );
  return {
    title,
    role: nodeVisualRole({
      nodeType,
      title,
      category:
        typeof data.__category === "string" ? data.__category : undefined,
      pure: data.__pure === true,
      latent: data.__latent === true,
    }),
  };
}

function zipPinRows(
  pins: SerializedPin[],
): Array<{ in?: SerializedPin; out?: SerializedPin }> {
  const execIn = pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "in",
  );
  const execOut = pins.filter(
    (pin) => pin.kind === "exec" && pin.direction === "out",
  );
  const dataIn = pins.filter(
    (pin) => pin.kind !== "exec" && pin.direction === "in",
  );
  const dataOut = pins.filter(
    (pin) => pin.kind !== "exec" && pin.direction === "out",
  );
  const rows: Array<{ in?: SerializedPin; out?: SerializedPin }> = [];
  const execCount = Math.max(execIn.length, execOut.length);
  for (let i = 0; i < execCount; i++) {
    rows.push({ in: execIn[i], out: execOut[i] });
  }
  const dataCount = Math.max(dataIn.length, dataOut.length);
  for (let i = 0; i < dataCount; i++) {
    rows.push({ in: dataIn[i], out: dataOut[i] });
  }
  return rows;
}

function PinVisual({ type }: { type: PinTypeRef }) {
  const shape = pinVisualShape(type);
  const color = pinCssVar(type);
  const size = "var(--graph-pin-size, 22px)";

  if (shape === "list") {
    return (
      <svg
        className="graph-pin-visual block"
        data-pin-shape="list"
        viewBox="0 0 22 22"
        aria-hidden="true"
        style={{ width: size, height: size, color }}
      >
        {[3, 9, 15].map((y) => (
          <rect
            key={y}
            x="2"
            y={y}
            width="18"
            height="4"
            rx="1"
            fill="currentColor"
            stroke="var(--card)"
            strokeWidth="2"
          />
        ))}
      </svg>
    );
  }

  return (
    <span
      className={cn(
        "graph-pin-visual block border-2 border-card",
        shape === "diamond" ? "rotate-45 rounded-sm" : "rounded-full",
      )}
      data-pin-shape={shape}
      style={{
        width: size,
        height: size,
        background: color,
      }}
      aria-hidden="true"
    />
  );
}

function PinHandle({
  nodeId,
  pin,
  pending,
  hasError,
}: {
  nodeId: string;
  pin: SerializedPin;
  pending: boolean;
  hasError: boolean;
}) {
  const { onPinTap, pinDisplayType } = useGraphEditorContext();
  const isSource = pin.direction === "out";
  const displayType = pinDisplayType(nodeId, pin.id) ?? pin.type;

  return (
    <Handle
      id={pin.id}
      type={isSource ? "source" : "target"}
      position={isSource ? Position.Right : Position.Left}
      aria-label={humanizePropertyLabel(pin.name)}
      data-pin-type={pin.type.kind}
      data-error={hasError ? "true" : undefined}
      className={cn(
        "!relative !top-auto !right-auto !left-auto !translate-x-0 !translate-y-0",
        "!pointer-events-auto flex !size-11 !min-h-11 !min-w-11 items-center justify-center",
        "!border-0 !bg-transparent touch-manipulation",
        pending && "ring-2 ring-primary ring-offset-1 ring-offset-card",
      )}
      style={{
        position: "relative",
        top: "auto",
        left: "auto",
        right: "auto",
        transform: "none",
        width: "var(--touch-target, 44px)",
        height: "var(--touch-target, 44px)",
        background: "transparent",
        border: "none",
      }}
      onClick={(event) => {
        event.stopPropagation();
        onPinTap(nodeId, pin.id, pin.direction);
      }}
    >
      <PinVisual type={displayType} />
    </Handle>
  );
}

function PinRow({
  nodeId,
  incoming,
  outgoing,
}: {
  nodeId: string;
  incoming?: SerializedPin;
  outgoing?: SerializedPin;
}) {
  const { pendingPin, pinHasError } = useGraphEditorContext();

  const isPending = (pin: SerializedPin | undefined) =>
    Boolean(
      pin && pendingPin?.nodeId === nodeId && pendingPin.pinId === pin.id,
    );

  return (
    <div className="flex min-h-[var(--touch-target,44px)] items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center">
        {incoming ? (
          <>
            <PinHandle
              nodeId={nodeId}
              pin={incoming}
              pending={isPending(incoming)}
              hasError={pinHasError(nodeId, incoming.id)}
            />
            <span className="max-w-[9rem] text-sm leading-snug break-words text-foreground">
              {humanizePropertyLabel(incoming.name)}
            </span>
          </>
        ) : (
          <span className="size-11 shrink-0" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end">
        {outgoing ? (
          <>
            <span className="max-w-[9rem] text-right text-sm leading-snug break-words text-foreground">
              {humanizePropertyLabel(outgoing.name)}
            </span>
            <PinHandle
              nodeId={nodeId}
              pin={outgoing}
              pending={isPending(outgoing)}
              hasError={pinHasError(nodeId, outgoing.id)}
            />
          </>
        ) : (
          <span className="size-11 shrink-0" />
        )}
      </div>
    </div>
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
      className="absolute -right-2 -top-2 z-10 flex size-11 items-center justify-center"
      aria-label={`${count} error${count === 1 ? "" : "s"}`}
      onClick={handleClick}
    >
      <span className="flex size-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
        {count > 9 ? "9+" : count}
      </span>
    </button>
  );
}

function shellIsDevelopmentOnly(
  nodeId: string,
  data: Record<string, unknown> | undefined,
): boolean {
  if (!data) return false;
  return isDevelopmentOnlyNode({
    id: nodeId,
    typeId: typeof data.__nodeType === "string" ? data.__nodeType : "",
    position: { x: 0, y: 0 },
    pins: [],
    properties: data,
  });
}

export function BlueprintNodeShell({
  nodeId,
  title,
  role,
  selected,
  data,
  children,
}: {
  nodeId: string;
  title: string;
  role: NodeVisualRole;
  selected?: boolean;
  data?: Record<string, unknown>;
  children: ReactNode;
}) {
  const { nodeErrorCount } = useGraphEditorContext();
  const developmentOnly = shellIsDevelopmentOnly(nodeId, data);

  return (
    <div className="relative">
      <NodeErrorBadge nodeId={nodeId} count={nodeErrorCount(nodeId)} />
      <div
        data-node-role={role}
        className={cn(
          "min-w-72 overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-md",
          selected && "ring-2 ring-primary",
        )}
      >
        <div
          className={cn(
            "rounded-t-lg px-3 py-2 text-sm font-semibold leading-snug break-words text-node-title",
            nodeRoleClass(role),
          )}
        >
          {title}
        </div>
        {children}
        {developmentOnly ? (
          <div
            className="graph-node-dev-only-tape pointer-events-none h-5 select-none"
            data-testid="development-only-banner"
            role="img"
            aria-label="Development Only"
          />
        ) : null}
      </div>
    </div>
  );
}

export function PinNode({ id, data, type, selected }: NodeProps<CanvasNode>) {
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { title, role } = visualFromData(data, type);
  const rows = zipPinRows(pins);

  return (
    <BlueprintNodeShell
      nodeId={id}
      title={title}
      role={role}
      selected={selected}
      data={data}
    >
      <div className="flex flex-col py-1">
        {rows.map((row, index) => (
          <PinRow
            key={row.in?.id ?? row.out?.id ?? `row-${index}`}
            nodeId={id}
            incoming={row.in}
            outgoing={row.out}
          />
        ))}
      </div>
    </BlueprintNodeShell>
  );
}

export function LogMessageNode({
  id,
  data,
  selected,
}: NodeProps<Node<LogNodeData>>) {
  return (
    <BlueprintNodeShell
      nodeId={id}
      title="Log Message"
      role="debug"
      selected={selected}
      data={data}
    >
      <div className="px-3 py-2 text-sm">{data.message}</div>
    </BlueprintNodeShell>
  );
}

export function resolveNodeType(
  type: string,
  data: Record<string, unknown>,
  knownTypes: Record<string, unknown> = graphNodeTypes,
): string {
  if (type in knownTypes) return type;
  if (type === "logMessage" && !hasSerializedPins(data)) {
    return "logMessage";
  }
  return "pinNode";
}

export const graphNodeTypes = {
  logMessage: LogMessageNode,
  pinNode: PinNode,
};
