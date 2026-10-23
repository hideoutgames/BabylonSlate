import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ClockIcon, Gamepad2Icon, PlugIcon, PlugZapIcon } from "lucide-react";
import {
  humanizePropertyLabel,
  PinShapeGlyph,
  tagDisplayName,
  useTags,
} from "@haptic/editor-kit";
import { EVENT_BY_TYPE_ID, isDevelopmentOnlyNode, isTouchEventNodeType } from "@haptic/scripting";
import { cn } from "@haptic/ui/lib/utils";
import { useGraphEditorContext } from "./graph-editor-context";
import { nodeCanBreak, useNodeBreakpoint } from "./graph-breakpoints";
import { useNodeMenu } from "./use-node-menu";
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
import { pinDefaultPreview, readPinDefaultValue } from "./pin-default-preview";
import { PinDefaultEditor } from "./pin-default-editor";
import { isPinWired } from "./pin-connections";

export type CanvasNode = Node<Record<string, unknown>>;

/** The title a node shows, as hosts name it outside the canvas (the Breakpoints window). */
export function canvasNodeTitle(data: Record<string, unknown>, type: string | undefined): string {
  return visualFromData(data, type).title;
}

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
      material: data.__material === true,
      latent: data.__latent === true,
      particleRole:
        typeof data.__particleRole === "string" ? data.__particleRole : undefined,
    }),
  };
}

/**
 * Pair input and output pins into node rows. Exec pins are lifted to the top
 * unless `declaredOrder` is set (function signatures), which keeps each side
 * in the order the pins were declared.
 */
export function zipPinRows(
  pins: SerializedPin[],
  options?: { declaredOrder?: boolean },
): Array<{ in?: SerializedPin; out?: SerializedPin }> {
  if (options?.declaredOrder) {
    const inputs = pins.filter((pin) => pin.direction === "in");
    const outputs = pins.filter((pin) => pin.direction === "out");
    return Array.from(
      { length: Math.max(inputs.length, outputs.length) },
      (_, index) => ({ in: inputs[index], out: outputs[index] }),
    );
  }
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

function PinHandle({
  nodeId,
  pin,
  pending,
  hasError,
  connected,
  disabled,
  label,
}: {
  nodeId: string;
  pin: SerializedPin;
  label?: string;
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
      aria-label={label ?? humanizePropertyLabel(pin.name)}
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
  const { pendingPin, pinHasError, pinTypeNames, pinDisplayType, onPinDefaultChange, renderPinDefaultEditor, connectedInputs } = useGraphEditorContext();
  const { entries: tags } = useTags();
  const outgoingTag = data.__nodeType === "tags.switch" && outgoing?.id.startsWith("case:")
    ? Number(outgoing.id.slice(5)) : undefined;
  const incomingTag = data.__nodeType === "tags.select" && incoming?.id.startsWith("option:")
    ? Number(incoming.id.slice(7)) : undefined;
  const incomingName = incomingTag !== undefined ? tagDisplayName(tags, incomingTag)
    : incoming ? humanizePropertyLabel(incoming.name) : "";
  const outgoingLabel = outgoingTag !== undefined ? tagDisplayName(tags, outgoingTag)
    : outgoing ? humanizePropertyLabel(outgoing.name) : "";
  const incomingConnected = useStore((state) =>
    incoming ? isPinWired(state.edges, nodeId, incoming) : false,
  );
  // An unwired pin that reads Self says so in its label.
  const incomingLabel = incoming?.selfWhenUnwired && !incomingConnected ? `${incomingName} (Self)` : incomingName;
  const outgoingConnected = useStore((state) =>
    outgoing ? isPinWired(state.edges, nodeId, outgoing) : false,
  );
  const displayedIncoming = incoming ? { ...incoming, type: pinDisplayType(nodeId, incoming.id) ?? incoming.type } : undefined;
  const preview = displayedIncoming
    ? pinDefaultPreview(displayedIncoming, data, incomingConnected, pinTypeNames)
    : null;

  const isPending = (pin: SerializedPin | undefined) =>
    Boolean(
      pin && pendingPin?.nodeId === nodeId && pendingPin.pinId === pin.id,
    );

  const disabled = data.__disabled === true;

  return (
    <div
      data-pin-row
      className="flex w-full min-h-[var(--touch-target,44px)] min-w-max items-center justify-between gap-12"
    >
      <div
        className="flex shrink-0 items-center gap-1"
        data-pin-side={incoming ? "in" : undefined}
        data-pin-id={incoming?.id}
      >
        {incoming ? (
          <>
            <PinHandle
              nodeId={nodeId}
              pin={incoming}
              label={incomingLabel}
              pending={isPending(incoming)}
              hasError={pinHasError(nodeId, incoming.id)}
              connected={incomingConnected}
              disabled={disabled}
            />
            {preview && displayedIncoming ? <PinDefaultEditor
              nodeId={nodeId} nodeData={data} nodeType={typeof data.__nodeType === "string" ? data.__nodeType : undefined}
              connectedInputIds={connectedInputs?.get(nodeId)}
              pin={{ ...displayedIncoming, name: incomingLabel }} preview={preview} value={readPinDefaultValue(displayedIncoming, data)}
              disabled={disabled || !onPinDefaultChange} onChange={(value) => onPinDefaultChange?.(nodeId, incoming.id, value)}
              renderer={renderPinDefaultEditor}
            /> : null}
            <span
              data-pin-label={incoming.name}
              className="shrink-0 whitespace-nowrap text-base leading-snug text-foreground"
            >
              {incomingLabel}
              {incoming.typeLabel ? <span className="ml-1 text-xs text-muted-foreground">{incoming.typeLabel}</span> : null}
            </span>
          </>
        ) : (
          <span className="size-11 shrink-0" />
        )}
      </div>
      <div
        className="flex shrink-0 items-center justify-end gap-1"
        data-pin-side={outgoing ? "out" : undefined}
        data-pin-id={outgoing?.id}
      >
        {outgoing ? (
          <>
            <span
              data-pin-label={outgoing.name}
              className="shrink-0 whitespace-nowrap text-right text-base leading-snug text-foreground"
            >
              {outgoingLabel}
              {outgoing.typeLabel ? <span className="ml-1 text-xs text-muted-foreground">{outgoing.typeLabel}</span> : null}
            </span>
            <PinHandle
              nodeId={nodeId}
              pin={outgoing}
              label={outgoingLabel}
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
  leading = false,
}: {
  nodeId: string;
  count: number;
  leading?: boolean;
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
      className={cn(
        "absolute -top-2 z-10 flex size-11 items-center justify-center",
        leading ? "-left-2" : "-right-2",
      )}
      aria-label={`${count} error${count === 1 ? "" : "s"}`}
      onClick={handleClick}
    >
      <span className="flex size-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
        {count > 9 ? "9+" : count}
      </span>
    </button>
  );
}

/**
 * A node's breakpoint at the start of its title bar, or on the left edge of a card node's header: a red
 * dot, hollow while disabled. With a mouse the dot toggles it, and a faint dot on title-bar (or card)
 * hover adds one; touch uses the node menu, and the keyboard the canvas's Toggle Breakpoint key.
 */
export function NodeBreakpointDot({ nodeId, data, className }: {
  nodeId: string;
  data?: Record<string, unknown>;
  /** Places the dot; the default sits at the start of a title bar. */
  className?: string;
}) {
  const { breakpoints } = useGraphEditorContext();
  const state = useNodeBreakpoint(nodeId);
  if (!breakpoints || !nodeCanBreak(breakpoints, nodeId, data)) return null;
  const label = state ? "Remove Breakpoint" : "Add Breakpoint";
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      data-breakpoint={state ?? undefined}
      className={cn(
        "nodrag absolute flex size-3 -translate-y-1/2 items-center justify-center pointer-coarse:pointer-events-none",
        className ?? "left-1 top-1/2",
        !state && "opacity-0 group-hover/title:opacity-40 pointer-coarse:hidden",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        breakpoints.toggle(nodeId);
      }}
    >
      <span className={cn("size-2.5 rounded-full border-2 border-destructive", state !== "disabled" && "bg-destructive")} />
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

const INPUT_EVENT_TYPE_IDS = new Set([
  "input.actionEvent",
  "input.axisEvent",
  "input.onAnyKeyPressed",
  "input.onGamepadConnected",
  "input.onGamepadDisconnected",
]);

// Custom Events only get the event marker when they override a parent script's event.
function isInheritedCustomEvent(nodeType: string, data: Record<string, unknown> | undefined) {
  if (nodeType !== "flow.event.custom") return false;
  return data?.eventQualifier === "Inherited" || (typeof data?.parentClassId === "string" && data.parentClassId !== "");
}

function nodeCornerMarker(data: Record<string, unknown> | undefined) {
  if (data?.__material || data?.__particleRole) return null;
  const nodeType = typeof data?.__nodeType === "string" ? data.__nodeType : "";
  if (data?.__latent === true || (nodeType === "debug.executeJavaScript" && data?.async === true)) {
    return { Icon: ClockIcon, label: "Latent Action" };
  }
  if (nodeType === "interface.call" || data?.__interface === true) {
    return { Icon: PlugIcon, label: "Script Interface Function" };
  }
  if (INPUT_EVENT_TYPE_IDS.has(nodeType) || isTouchEventNodeType(nodeType)) {
    return { Icon: Gamepad2Icon, label: "Input Event" };
  }
  if (Object.hasOwn(EVENT_BY_TYPE_ID, nodeType) || isInheritedCustomEvent(nodeType, data)) {
    return { Icon: PlugZapIcon, label: "Event" };
  }
  return null;
}

export function BlueprintNodeShell({
  nodeId,
  title,
  role,
  selected,
  data,
  children,
  card = false,
}: {
  nodeId: string;
  title: string;
  role: NodeVisualRole;
  selected?: boolean;
  data?: Record<string, unknown>;
  children: ReactNode;
  /** Fixed-width flat card without the role title bar; children render their own header. */
  card?: boolean;
}) {
  const { nodeErrorCount } = useGraphEditorContext();
  const developmentOnly = shellIsDevelopmentOnly(nodeId, data);
  const editorOnly = data?.__editorOnly === true;
  const disabled = data?.__disabled === true;
  const marker = nodeCornerMarker(data);

  return (
    <div className={cn("relative", card && "group/title")}>
      <NodeErrorBadge nodeId={nodeId} count={nodeErrorCount(nodeId)} leading={!!marker} />
      {/* Outside the card's clipped body, straddling its left border at the header. */}
      {card ? <NodeBreakpointDot nodeId={nodeId} data={data} className="-left-1.5 top-6 z-10" /> : null}
      {marker ? (
        <span
          role="img"
          aria-label={marker.label}
          className={cn(
            "pointer-events-none absolute right-1.5 top-1.5 z-10 flex translate-x-1/2 -translate-y-1/2 items-center justify-center text-foreground drop-shadow-[0_2px_3px_rgb(0_0_0/0.6)]",
            disabled && "opacity-50",
          )}
        >
          <marker.Icon className="size-11" strokeWidth={2} aria-hidden="true" />
        </span>
      ) : null}
      <div
        data-node-role={role}
        data-disabled={disabled ? "true" : undefined}
        data-selected={card ? (selected ? "true" : "false") : undefined}
        className={cn(
          "overflow-hidden border border-border bg-graph-node text-card-foreground shadow-sm",
          card
            ? "graph-card-node w-56 rounded-md"
            : cn("w-max min-w-80 rounded-lg", selected && "ring-2 ring-primary"),
          disabled && "opacity-50",
        )}
      >
        {card ? null : (
          <div
            className={cn(
              "group/title relative rounded-t-lg px-4 py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title",
              marker && "pr-10",
              nodeRoleClass(role),
            )}
          >
            <NodeBreakpointDot nodeId={nodeId} data={data} />
            {title}
          </div>
        )}
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
  const { renderNodeBody } = useGraphEditorContext();
  const nodeMenu = useNodeMenu(id);
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { title, role } = visualFromData(data, type);
  const rows = zipPinRows(pins, {
    declaredOrder: data.__declaredPinOrder === true,
  });
  // Reordering pins moves handles without resizing the node, so React Flow
  // would keep drawing edges to the old handle positions. Mount is measured
  // normally; re-measuring there disturbs initial layout of off-screen nodes.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleOrder = pins.map((pin) => `${pin.direction}:${pin.id}`).join("|");
  const measuredHandleOrder = useRef(handleOrder);
  useEffect(() => {
    if (measuredHandleOrder.current === handleOrder) return;
    measuredHandleOrder.current = handleOrder;
    updateNodeInternals(id);
  }, [handleOrder, id, updateNodeInternals]);

  return (
    <div {...nodeMenu.bind}>
      <BlueprintNodeShell
        nodeId={id}
        title={title}
        role={role}
        selected={selected}
        data={data}
      >
        <div className="flex flex-col py-1">
          {rows.map((row, index) => (
            <div key={row.in?.id ?? row.out?.id ?? `row-${index}`}>
            {row.in?.group ? <div className="border-t px-3 py-1 text-xs text-muted-foreground">{row.in.group}</div> : null}
            <PinRow
              nodeId={id}
              data={data}
              incoming={row.in}
              outgoing={row.out}
            />
            </div>
          ))}
        </div>
        {renderNodeBody?.(id, data)}
      </BlueprintNodeShell>
      {nodeMenu.overlay}
    </div>
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
  const nodeMenu = useNodeMenu(id);

  const isPending = (pin: SerializedPin) =>
    Boolean(pendingPin?.nodeId === id && pendingPin.pinId === pin.id);

  return (
    <div className="relative" {...nodeMenu.bind}>
      <NodeErrorBadge nodeId={id} count={nodeErrorCount(id)} />
      <div
        data-node-role="variable"
        data-node-kind="variable-get"
        data-disabled={disabled ? "true" : undefined}
        className={cn(
          "flex min-h-14 w-max items-center gap-4 rounded-full border-2 bg-card px-4 text-card-foreground shadow-md",
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
              className="shrink-0 px-3 whitespace-nowrap text-base leading-snug text-foreground"
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
      {nodeMenu.overlay}
    </div>
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
  return "pinNode";
}

export const graphNodeTypes = {
  pinNode: PinNode,
  variableGet: VariableGetNode,
};
