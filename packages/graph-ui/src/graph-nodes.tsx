import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, type MouseEvent, type ReactNode } from "react";
import { humanizePropertyLabel, PinShapeGlyph } from "@babylonslate/editor-kit";
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
import { pinDefaultPreview } from "./pin-default-preview";
import { PinDefaultPreviewWidget } from "./pin-default-widget";

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
    typeof data.eventQualifier === "string" ? data.eventQualifier : undefined,
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

export function zipPinRows(
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
  let dataInIndex = 0;
  let dataOutIndex = 0;
  for (const row of rows) {
    if (!row.in && dataInIndex < dataIn.length) {
      row.in = dataIn[dataInIndex];
      dataInIndex += 1;
    }
    if (!row.out && dataOutIndex < dataOut.length) {
      row.out = dataOut[dataOutIndex];
      dataOutIndex += 1;
    }
  }
  const dataCount = Math.max(
    dataIn.length - dataInIndex,
    dataOut.length - dataOutIndex,
  );
  for (let i = 0; i < dataCount; i++) {
    rows.push({
      in: dataIn[dataInIndex + i],
      out: dataOut[dataOutIndex + i],
    });
  }
  return rows;
}

function PinVisual({
  type,
  connected,
}: {
  type: PinTypeRef;
  connected: boolean;
}) {
  return (
    <PinShapeGlyph
      shape={pinVisualShape(type)}
      connected={connected}
      color={pinCssVar(type)}
      size="var(--graph-pin-size, 22px)"
      className="graph-pin-visual"
    />
  );
}

function isPinWired(
  edges: ReadonlyArray<{
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }>,
  nodeId: string,
  pin: SerializedPin,
): boolean {
  return edges.some((edge) =>
    pin.direction === "out"
      ? edge.source === nodeId && (edge.sourceHandle ?? "") === pin.id
      : edge.target === nodeId && (edge.targetHandle ?? "") === pin.id,
  );
}

function PinHandle({
  nodeId,
  pin,
  pending,
  hasError,
  connected,
  disabled,
}: {
  nodeId: string;
  pin: SerializedPin;
  pending: boolean;
  hasError: boolean;
  connected: boolean;
  disabled?: boolean;
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
      isConnectable={!disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onPinTap(nodeId, pin.id, pin.direction);
      }}
    >
      <PinVisual type={displayType} connected={connected} />
    </Handle>
  );
}

function PinRow({
  nodeId,
  data,
  incoming,
  outgoing,
}: {
  nodeId: string;
  data: Record<string, unknown>;
  incoming?: SerializedPin;
  outgoing?: SerializedPin;
}) {
  const { pendingPin, pinHasError, pinTypeNames } = useGraphEditorContext();
  const incomingConnected = useStore((state) =>
    incoming ? isPinWired(state.edges, nodeId, incoming) : false,
  );
  const outgoingConnected = useStore((state) =>
    outgoing ? isPinWired(state.edges, nodeId, outgoing) : false,
  );
  const preview = incoming
    ? pinDefaultPreview(incoming, data, incomingConnected, pinTypeNames)
    : null;

  const isPending = (pin: SerializedPin | undefined) =>
    Boolean(
      pin && pendingPin?.nodeId === nodeId && pendingPin.pinId === pin.id,
    );

  const disabled = data.__disabled === true;

  return (
    <div className="flex min-h-[var(--touch-target,44px)] items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {incoming ? (
          <>
            <PinHandle
              nodeId={nodeId}
              pin={incoming}
              pending={isPending(incoming)}
              hasError={pinHasError(nodeId, incoming.id)}
              connected={incomingConnected}
              disabled={disabled}
            />
            {preview ? <PinDefaultPreviewWidget preview={preview} /> : null}
            <span
              data-pin-label={incoming.name}
              className="whitespace-nowrap text-base leading-snug text-foreground"
            >
              {humanizePropertyLabel(incoming.name)}
            </span>
          </>
        ) : (
          <span className="size-11 shrink-0" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {outgoing ? (
          <>
            <span
              data-pin-label={outgoing.name}
              className="whitespace-nowrap text-right text-base leading-snug text-foreground"
            >
              {humanizePropertyLabel(outgoing.name)}
            </span>
            <PinHandle
              nodeId={nodeId}
              pin={outgoing}
              pending={isPending(outgoing)}
              hasError={pinHasError(nodeId, outgoing.id)}
              connected={outgoingConnected}
              disabled={disabled}
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
  compact = false,
}: {
  nodeId: string;
  title: string;
  role: NodeVisualRole;
  selected?: boolean;
  data?: Record<string, unknown>;
  children: ReactNode;
  compact?: boolean;
}) {
  const { nodeErrorCount } = useGraphEditorContext();
  const developmentOnly = shellIsDevelopmentOnly(nodeId, data);
  const editorOnly = data?.__editorOnly === true;
  const disabled = data?.__disabled === true;

  return (
    <div className="relative">
      <NodeErrorBadge nodeId={nodeId} count={nodeErrorCount(nodeId)} />
      <div
        data-node-role={role}
        data-disabled={disabled ? "true" : undefined}
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-md",
          compact ? "min-w-56" : "w-max min-w-80",
          selected && "ring-2 ring-primary",
          disabled && "opacity-50",
        )}
      >
        <div
          className={cn(
            "rounded-t-lg px-4 py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title",
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
        {editorOnly ? (
          <div
            className="graph-node-editor-only-tape pointer-events-none h-5 select-none"
            data-testid="editor-only-banner"
            role="img"
            aria-label="Editor Only"
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
            data={data}
            incoming={row.in}
            outgoing={row.out}
          />
        ))}
      </div>
    </BlueprintNodeShell>
  );
}

export function VariableGetNode({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { pendingPin, pinHasError, pinDisplayType, nodeErrorCount } =
    useGraphEditorContext();
  const dataPins = pins.filter((pin) => pin.kind !== "exec");
  const incoming = dataPins.filter((pin) => pin.direction === "in");
  const outgoing = dataPins.find((pin) => pin.direction === "out");
  const edges = useStore((state) => state.edges);
  const valueType = outgoing
    ? (pinDisplayType(id, outgoing.id) ?? outgoing.type)
    : { kind: "wildcard" };
  const disabled = data.__disabled === true;

  const isPending = (pin: SerializedPin) =>
    Boolean(pendingPin?.nodeId === id && pendingPin.pinId === pin.id);

  return (
    <div className="relative">
      <NodeErrorBadge nodeId={id} count={nodeErrorCount(id)} />
      <div
        data-node-role="variable"
        data-node-kind="variable-get"
        data-disabled={disabled ? "true" : undefined}
        className={cn(
          "flex min-h-[var(--touch-target,44px)] w-max items-center rounded-full border-2 bg-card text-card-foreground shadow-md",
          incoming.length === 0 && "pl-3",
          selected && "ring-2 ring-primary",
          disabled && "opacity-50",
        )}
        style={{ borderColor: pinCssVar(valueType) }}
      >
        {incoming.map((pin) => (
          <PinHandle
            key={pin.id}
            nodeId={id}
            pin={pin}
            pending={isPending(pin)}
            hasError={pinHasError(id, pin.id)}
            connected={isPinWired(edges, id, pin)}
            disabled={disabled}
          />
        ))}
        {outgoing ? (
          <>
            <span
              data-pin-label={outgoing.name}
              className="whitespace-nowrap text-base leading-snug text-foreground"
            >
              {humanizePropertyLabel(outgoing.name)}
            </span>
            <PinHandle
              nodeId={id}
              pin={outgoing}
              pending={isPending(outgoing)}
              hasError={pinHasError(id, outgoing.id)}
              connected={isPinWired(edges, id, outgoing)}
              disabled={disabled}
            />
          </>
        ) : null}
      </div>
    </div>
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
  const typeId = typeof data.__nodeType === "string" ? data.__nodeType : type;
  if (typeId === "variables.get" || typeId.startsWith("variables.get:")) {
    return "variableGet";
  }
  if (type in knownTypes) return type;
  if (type === "logMessage" && !hasSerializedPins(data)) {
    return "logMessage";
  }
  return "pinNode";
}

export const graphNodeTypes = {
  logMessage: LogMessageNode,
  pinNode: PinNode,
  variableGet: VariableGetNode,
};
