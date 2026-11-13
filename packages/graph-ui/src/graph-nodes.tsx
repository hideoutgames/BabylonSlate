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
  useContext,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { UserFocusIcon } from "@phosphor-icons/react/dist/csr/UserFocus";
import {
  CircleAlertIcon,
  ClockIcon,
  Gamepad2Icon,
  OctagonPauseIcon,
  PlugIcon,
  PlugZapIcon,
  RadioTowerIcon,
} from "lucide-react";
import ImageGlyph from "react-bootstrap-icons/dist/icons/image";
import ImageFillGlyph from "react-bootstrap-icons/dist/icons/image-fill";
import {
  humanizePropertyLabel,
  LabelHint,
  PinShapeGlyph,
  tagDisplayName,
  useTags,
} from "@haptic/editor-kit";
import { EVENT_BY_TYPE_ID, isDevelopmentOnlyNode, isTouchEventNodeType } from "@haptic/scripting";
import { Badge } from "@haptic/ui/components/badge";
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
  pinTypeLetter,
  pinVisualShape,
  type NodeVisualRole,
  type PinTypeRef,
} from "./node-theme";
import { GraphInteractionSettingsContext } from "./graph-interaction-settings";
import { pinDefaultPreview, readPinDefaultValue } from "./pin-default-preview";
import { PinDefaultEditor } from "./pin-default-editor";
import { isPinWired, passesReference } from "./pin-connections";

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
  pin,
  connected,
  byReference = false,
}: {
  type: PinTypeRef;
  pin?: SerializedPin;
  connected: boolean;
  /** A variable output wired into a reference input: drawn as the reference it passes. */
  byReference?: boolean;
}) {
  const { pinTypeLetters } = useContext(GraphInteractionSettingsContext);
  const shape = byReference ? "reference" : pinVisualShape(type, pin);
  const color = pinCssVar(type);
  if (type.kind === "pose" || type.kind === "frame") {
    return <AnimPinGlyph kind={type.kind} color={color} connected={connected} />;
  }
  const glyph = (
    <PinShapeGlyph
      shape={shape}
      connected={connected}
      color={color}
      size="var(--graph-pin-glyph, var(--graph-pin-size, 22px))"
      className="graph-pin-visual"
    />
  );
  const letter = pinTypeLetters ? pinTypeLetter(type) : undefined;
  if (!letter) return glyph;
  // Filled pins (not list or map bars) show the letter in the card colour.
  const onFill = connected && shape !== "list" && shape !== "map";
  return (
    <span className="relative grid place-items-center">
      {glyph}
      <span
        className="graph-pin-letter"
        data-pin-letter={letter}
        data-on-fill={onFill ? "true" : undefined}
        style={{ color }}
        aria-hidden="true"
      >
        {letter}
      </span>
    </span>
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
  const byReference = useStore((state) => passesReference(state.edges, state.nodeLookup, nodeId, pin));

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
        "!pointer-events-auto flex !size-[var(--graph-pin-hit,44px)] !min-h-[var(--graph-pin-hit,44px)] !min-w-[var(--graph-pin-hit,44px)] items-center justify-center",
        "!border-0 !bg-transparent touch-manipulation",
        pending && "ring-2 ring-primary ring-offset-1 ring-offset-card",
      )}
      style={{
        position: "relative",
        top: "auto",
        left: "auto",
        right: "auto",
        transform: "none",
        width: "var(--graph-pin-hit, 44px)",
        height: "var(--graph-pin-hit, 44px)",
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
      <PinVisual type={displayType} pin={pin} connected={connected} byReference={byReference} />
    </Handle>
  );
}

/**
 * An Animation Graph's Pose pin (Phosphor User Focus) or Frame pin (Bootstrap Image), drawn larger than other pins and
 * without a box: the icon's outline glyph while unwired, its fill glyph once wired.
 */
function AnimPinGlyph({ kind, color, connected }: { kind: "pose" | "frame"; color: string; connected: boolean }) {
  const size = "calc(var(--graph-pin-glyph, var(--graph-pin-size, 22px)) * 1.2)";
  const FrameGlyph = connected ? ImageFillGlyph : ImageGlyph;
  return (
    <span
      className="graph-pin-visual relative block"
      data-pin-shape={kind}
      data-connected={connected ? "true" : "false"}
      style={{ width: size, height: size, color }}
      aria-hidden="true"
    >
      {kind === "pose" ? (
        <UserFocusIcon className="absolute inset-0 size-full" size="100%" weight={connected ? "fill" : "regular"} />
      ) : (
        <FrameGlyph className="absolute inset-0 size-full" size="100%" />
      )}
    </span>
  );
}

/**
 * An output drawn at the right end of the title bar, aligned with the output
 * handles of the rows below: a custom event's Output Delegate, as in Unreal.
 */
function HeaderPin({
  nodeId,
  pin,
  disabled,
}: {
  nodeId: string;
  pin: SerializedPin;
  disabled: boolean;
}) {
  const { pendingPin, pinHasError } = useGraphEditorContext();
  const connected = useStore((state) => isPinWired(state.edges, nodeId, pin));
  const label = humanizePropertyLabel(pin.name);
  return (
    <span
      className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center"
      data-pin-side={pin.direction}
      data-pin-id={pin.id}
      data-header-pin
    >
      <PinHandle
        nodeId={nodeId}
        pin={pin}
        label={label}
        pending={pendingPin?.nodeId === nodeId && pendingPin.pinId === pin.id}
        hasError={pinHasError(nodeId, pin.id)}
        connected={connected}
        disabled={disabled}
      />
    </span>
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
  // An unwired pin that reads Self shows a Self field; the handle names it for assistive technology.
  const incomingHandleLabel = incoming?.selfWhenUnwired && !incomingConnected ? `${incomingName} (Self)` : incomingName;
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
              label={incomingHandleLabel}
              pending={isPending(incoming)}
              hasError={pinHasError(nodeId, incoming.id)}
              connected={incomingConnected}
              disabled={disabled}
            />
            {preview && displayedIncoming ? <PinDefaultEditor
              nodeId={nodeId} nodeData={data} nodeType={typeof data.__nodeType === "string" ? data.__nodeType : undefined}
              connectedInputIds={connectedInputs?.get(nodeId)}
              pin={{ ...displayedIncoming, name: incomingName }} preview={preview} value={readPinDefaultValue(displayedIncoming, data)}
              disabled={disabled || !onPinDefaultChange} onChange={(value) => onPinDefaultChange?.(nodeId, incoming.id, value)}
              renderer={renderPinDefaultEditor}
            /> : null}
            <PinHint pin={incoming}>
              <span
                data-pin-label={incoming.name}
                className="shrink-0 whitespace-nowrap text-base leading-snug text-foreground"
              >
                {incomingName}
                {incoming.typeLabel ? <span className="ml-1 text-xs text-muted-foreground">{incoming.typeLabel}</span> : null}
              </span>
            </PinHint>
          </>
        ) : (
          <span className="size-[var(--graph-pin-hit,44px)] shrink-0" />
        )}
      </div>
      <div
        className="flex shrink-0 items-center justify-end gap-1"
        data-pin-side={outgoing ? "out" : undefined}
        data-pin-id={outgoing?.id}
      >
        {outgoing ? (
          <>
            <PinHint pin={outgoing}>
              <span
                data-pin-label={outgoing.name}
                className="shrink-0 whitespace-nowrap text-right text-base leading-snug text-foreground"
              >
                {outgoingLabel}
                {outgoing.typeLabel ? <span className="ml-1 text-xs text-muted-foreground">{outgoing.typeLabel}</span> : null}
              </span>
            </PinHint>
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
          <span className="size-[var(--graph-pin-hit,44px)] shrink-0" />
        )}
      </div>
    </div>
  );
}

/**
 * A node's error count: a destructive Badge sitting just above the node's top edge, so it never covers
 * the title, the breakpoint tab or the corner marker (it moves to the left edge when a marker is shown).
 * Its 44px button reaches down to the node.
 */
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
  const label = count === 1 ? "1 Error" : `${count} Errors`;

  return (
    <button
      type="button"
      className={cn(
        "group/node-error absolute bottom-full z-10 flex h-11 items-end pb-1.5 outline-none",
        leading ? "left-0" : "right-0",
      )}
      aria-label={label}
      onClick={handleClick}
    >
      <span className="rounded-sm bg-graph-node shadow-md">
        {/* Node chrome is drawn at twice chrome scale (16px titles), so the badge is too. */}
        <Badge
          variant="destructive"
          size="lg"
          className="h-8 gap-1.5 text-sm tabular-nums has-data-[icon=inline-start]:pl-2 [&>svg]:size-4! dark:group-hover/node-error:bg-destructive/30 group-focus-visible/node-error:ring-[3px] group-focus-visible/node-error:ring-destructive/40"
        >
          <CircleAlertIcon data-icon="inline-start" aria-hidden="true" />
          {label}
        </Badge>
      </span>
    </button>
  );
}

/** Where a node shows its breakpoint tab. */
export type NodeBreakpointPlacement = "titleBar" | "cardTop" | "inset";

const BREAKPOINT_TAB_PLACEMENT: Record<NodeBreakpointPlacement, string> = {
  // Outside the title bar's left end, as tall as the bar (42px below the shell's 1px border).
  titleBar:
    "right-full top-px h-[2.625rem] w-9 rounded-l-md [&_svg]:size-[1.375rem] group-has-[[data-node-title]:hover]/node:opacity-40",
  // On a card's top edge at its left: siblings sit only 24px apart, so a tab beside the card would overlap one.
  cardTop: "bottom-full left-3 h-7 w-9 rounded-t-md [&_svg]:size-[1.125rem] group-hover/title:opacity-40",
  // Inside a node's top-left corner, for nodes whose sides carry handles (states).
  inset: "graph-breakpoint-tab-inset left-0 top-0 h-7 w-9 rounded-tl-[inherit] rounded-br-md [&_svg]:size-[1.125rem] group-hover/title:opacity-40",
};

/**
 * A node's breakpoint as a red tab with a stop sign, striped while disabled. With a mouse the tab
 * toggles it, and a faint tab on title-bar (or card) hover adds one; touch uses the node menu, and the
 * keyboard the canvas's breakpoint keys.
 */
export function NodeBreakpointTab({ nodeId, data, placement }: {
  nodeId: string;
  data?: Record<string, unknown>;
  placement: NodeBreakpointPlacement;
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
        "graph-breakpoint-tab nodrag absolute z-10 flex items-center justify-center pointer-coarse:pointer-events-none",
        BREAKPOINT_TAB_PLACEMENT[placement],
        !state && "opacity-0 hover:opacity-40 pointer-coarse:hidden",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        breakpoints.toggle(nodeId);
      }}
    >
      <OctagonPauseIcon aria-hidden="true" strokeWidth={2.25} />
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

/** Pins drawn in the title bar rather than in a pin row. */
function headerPinsOf(data: Record<string, unknown> | undefined): SerializedPin[] {
  return hasSerializedPins(data) ? data.__pins.filter((pin) => pin.placement === "header") : [];
}

function nodeCornerMarker(data: Record<string, unknown> | undefined) {
  if (data?.__material || data?.__particleRole) return null;
  const nodeType = typeof data?.__nodeType === "string" ? data.__nodeType : "";
  // A title-bar pin takes the corner (an inherited custom event's delegate square).
  if (headerPinsOf(data).length > 0) return null;
  if (nodeType.startsWith("flow.dispatcher.")) {
    return { Icon: RadioTowerIcon, label: "Event Dispatcher" };
  }
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

/** A canvas waits before a node or pin tooltip, so moving across nodes does not flash them. */
const GRAPH_HINT_DELAY_MS = 600;

/** A pin name with a `description` explains it as a tooltip (`LabelHint`). */
function PinHint({ pin, children }: { pin: SerializedPin; children: ReactElement }) {
  return pin.description ? <LabelHint hint={pin.description} delay={GRAPH_HINT_DELAY_MS}>{children}</LabelHint> : children;
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
  const { nodeErrorCount, describeNode } = useGraphEditorContext();
  const description = data ? describeNode?.(String(data.__nodeType ?? ""), data) : undefined;
  const developmentOnly = shellIsDevelopmentOnly(nodeId, data);
  const editorOnly = data?.__editorOnly === true;
  const disabled = data?.__disabled === true;
  const marker = nodeCornerMarker(data);
  const headerPins = card ? [] : headerPinsOf(data);

  return (
    <div className={cn("group/node relative", card && "group/title")}>
      <NodeErrorBadge nodeId={nodeId} count={nodeErrorCount(nodeId)} leading={!!marker || headerPins.length > 0} />
      {/* Outside the shell, which clips its body to the rounded corners. */}
      <NodeBreakpointTab nodeId={nodeId} data={data} placement={card ? "cardTop" : "titleBar"} />
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
            data-node-title=""
            className={cn(
              "group/title relative rounded-t-lg px-4 py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title",
              marker && "pr-10",
              headerPins.length > 0 && "pr-12",
              nodeRoleClass(role),
            )}
          >
            {description ? (
              <LabelHint hint={description} underline={false} delay={GRAPH_HINT_DELAY_MS}>
                <span data-node-title-hint="">{title}</span>
              </LabelHint>
            ) : title}
            {headerPins.map((pin) => (
              <HeaderPin key={pin.id} nodeId={nodeId} pin={pin} disabled={disabled} />
            ))}
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

function PinNode({ id, data, type, selected }: NodeProps<CanvasNode>) {
  const { renderNodeBody } = useGraphEditorContext();
  const nodeMenu = useNodeMenu(id);
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { title, role } = visualFromData(data, type);
  const rows = zipPinRows(pins.filter((pin) => pin.placement !== "header"), {
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

  // An Animation Graph's Output Pose (or Output Frame) is drawn like a state card, its pose input inside it.
  const nodeType = typeof data.__nodeType === "string" ? data.__nodeType : type;
  if (nodeType === "anim.pose.output" || nodeType === "anim.frame.output") {
    const input = pins.find((pin) => pin.direction === "in");
    return (
      <div {...nodeMenu.bind}>
        <div
          className={cn("anim-state-node anim-pose-output-node", selected && "anim-state-node-selected")}
          data-testid={`anim-pose-output-${id}`}
        >
          {input ? (
            <div className="anim-pose-output-pin">
              <PinHandle nodeId={id} pin={input} pending={false} hasError={false} connected />
            </div>
          ) : null}
          <div className="anim-state-node-title">{title}</div>
        </div>
        {nodeMenu.overlay}
      </div>
    );
  }
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

function VariableGetNode({
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
