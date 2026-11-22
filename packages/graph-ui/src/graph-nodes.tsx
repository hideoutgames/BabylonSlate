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
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { UserFocusIcon } from "@phosphor-icons/react/dist/csr/UserFocus";
import { CircleAlertIcon, EyeIcon, OctagonPauseIcon } from "lucide-react";
import ImageGlyph from "react-bootstrap-icons/dist/icons/image";
import ImageFillGlyph from "react-bootstrap-icons/dist/icons/image-fill";
import {
  humanizePropertyLabel,
  LabelHint,
  PinShapeGlyph,
  tagDisplayName,
  useDoubleTap,
  useTags,
} from "@haptic/editor-kit";
import { isDevelopmentOnlyNode, MATH_EXPRESSION_NODE_ID, mathExpressionNodeState } from "@haptic/scripting";
import { MathExpressionFormulaField } from "./math-expression-formula";
import { Badge } from "@haptic/ui/components/badge";
import { cn } from "@haptic/ui/lib/utils";
import { useGraphEditorContext } from "./graph-editor-context";
import { GraphNodeBodyContext, useConnectedInputs, useNodeErrorCount, useNodeRename, usePendingPinId, usePinDisplayType, usePinErrors, usePreviewedNode } from "./graph-node-state";
import { nodeCanBreak, useNodeBreakpoint } from "./graph-breakpoints";
import { useNodeMenu } from "./use-node-menu";
import { hasSerializedPins, isRerouteNodeData, type SerializedPin } from "./graph-types";
import { displayNodeTitle } from "./graph-connect";
import {
  headerContrastColor,
  nodeKind,
  nodeRoleClass,
  nodeVisualRole,
  pinCssVar,
  pinTypeLetter,
  pinVisualShape,
  type NodeKind,
  type NodeVisualRole,
  type PinTypeRef,
} from "./node-theme";
import { NodeKindIcon } from "./node-icons";
import { NodeRenameField, useNodeTitleGestures } from "./node-title";
import { GraphInteractionSettingsContext } from "./graph-interaction-settings";
import { pinDefaultPreview, readPinDefaultValue } from "./pin-default-preview";
import { PinDefaultEditor } from "./pin-default-editor";
import { NodeAddPinButton } from "./node-add-pin-button";
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
  kind: NodeKind;
} {
  const nodeType =
    typeof data.__nodeType === "string" ? data.__nodeType : (type ?? "Node");
  const title = displayNodeTitle(
    nodeType,
    typeof data.title === "string" ? data.title : undefined,
    typeof data.eventQualifier === "string" ? data.eventQualifier : undefined,
  );
  const input = {
    nodeType,
    title,
    category:
      typeof data.__category === "string" ? data.__category : undefined,
    pure: data.__pure === true,
    material: data.__material === true,
    latent: data.__latent === true,
    particleRole:
      typeof data.__particleRole === "string" ? data.__particleRole : undefined,
  };
  return {
    title,
    role: nodeVisualRole(input),
    kind: nodeKind({
      ...input,
      // An async Execute JavaScript waits like a latent call without the latent header colour.
      latent: input.latent || (nodeType === "debug.executeJavaScript" && data.async === true),
      interface: data.__interface === true,
      reroute: isRerouteNodeData(data),
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
  circle = false,
}: {
  type: PinTypeRef;
  pin?: SerializedPin;
  connected: boolean;
  /** A variable output wired into a reference input: drawn as the reference it passes. */
  byReference?: boolean;
  /** Always the round glyph, whatever the type (a Reroute knot's pins, exec included). */
  circle?: boolean;
}) {
  const { pinTypeLetters } = useContext(GraphInteractionSettingsContext);
  const shape = circle ? "circle" : byReference ? "reference" : pinVisualShape(type, pin);
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
  circle = false,
}: {
  nodeId: string;
  pin: SerializedPin;
  label?: string;
  pending: boolean;
  hasError: boolean;
  connected: boolean;
  disabled?: boolean;
  circle?: boolean;
}) {
  const { onPinTap } = useGraphEditorContext();
  const isSource = pin.direction === "out";
  const displayType = usePinDisplayType(nodeId, pin.id) ?? pin.type;
  const byReference = useStore((state) => passesReference(state.edges, state.nodeLookup, nodeId, pin));

  return (
    <Handle
      id={pin.id}
      type={isSource ? "source" : "target"}
      position={isSource ? Position.Right : Position.Left}
      aria-label={label ?? humanizePropertyLabel(pin.name)}
      data-pin-type={pin.type.kind}
      data-graph-pin=""
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
      <PinVisual type={displayType} pin={pin} connected={connected} byReference={byReference} circle={circle} />
    </Handle>
  );
}

/**
 * The host's body under a node's pins (`GraphEditor.renderNodeBody`). It reads the body renderer on
 * its own, so a host whose renderer changes with every edit renders only these, not every node.
 */
function NodeBody({ nodeId, data }: { nodeId: string; data: Record<string, unknown> }) {
  const renderNodeBody = useContext(GraphNodeBodyContext);
  return <>{renderNodeBody?.(nodeId, data)}</>;
}

/** A pin that reads whether it is wired itself, so a wire elsewhere renders only the pins it changes. */
function WiredPinHandle(props: Omit<Parameters<typeof PinHandle>[0], "connected">) {
  const connected = useStore((state) => isPinWired(state.edges, props.nodeId, props.pin));
  return <PinHandle {...props} connected={connected} />;
}

/**
 * An Animation Graph's Pose pin (Phosphor User Focus) or Frame pin (Bootstrap Image), drawn larger than other pins and
 * without a box: the icon's outline glyph while unwired, its fill glyph once wired. Phosphor pads its glyph, so the
 * Pose pin's box is larger for the figure to read as large as the Frame pin's picture.
 */
function AnimPinGlyph({ kind, color, connected }: { kind: "pose" | "frame"; color: string; connected: boolean }) {
  const size = `calc(var(--graph-pin-glyph, var(--graph-pin-size, 22px)) * ${kind === "pose" ? 1.6 : 1.4})`;
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
  const pendingPinId = usePendingPinId(nodeId);
  const pinHasError = usePinErrors(nodeId);
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
        pending={pendingPinId === pin.id}
        hasError={pinHasError(pin.id)}
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
  literalLabels = false,
}: {
  nodeId: string;
  data: Record<string, unknown>;
  incoming?: SerializedPin;
  outgoing?: SerializedPin;
  /** Names shown exactly as authored (a formula's variables), not humanized. */
  literalLabels?: boolean;
}) {
  const label = (pin: SerializedPin) => literalLabels ? pin.name : humanizePropertyLabel(pin.name);
  const { pinTypeNames, onPinDefaultChange, renderPinDefaultEditor } = useGraphEditorContext();
  const connectedInputIds = useConnectedInputs(nodeId);
  const incomingDisplayType = usePinDisplayType(nodeId, incoming?.id ?? "");
  const pendingPinId = usePendingPinId(nodeId);
  const pinHasError = usePinErrors(nodeId);
  const { entries: tags } = useTags();
  const outgoingTag = data.__nodeType === "tags.switch" && outgoing?.id.startsWith("case:")
    ? Number(outgoing.id.slice(5)) : undefined;
  const incomingTag = data.__nodeType === "tags.select" && incoming?.id.startsWith("option:")
    ? Number(incoming.id.slice(7)) : undefined;
  const incomingName = incomingTag !== undefined ? tagDisplayName(tags, incomingTag)
    : incoming ? label(incoming) : "";
  const outgoingLabel = outgoingTag !== undefined ? tagDisplayName(tags, outgoingTag)
    : outgoing ? label(outgoing) : "";
  const incomingConnected = useStore((state) =>
    incoming ? isPinWired(state.edges, nodeId, incoming) : false,
  );
  // An unwired pin that reads Self shows a Self field; the handle names it for assistive technology.
  const incomingHandleLabel = incoming?.selfWhenUnwired && !incomingConnected ? `${incomingName} (Self)` : incomingName;
  const outgoingConnected = useStore((state) =>
    outgoing ? isPinWired(state.edges, nodeId, outgoing) : false,
  );
  const displayedIncoming = incoming ? { ...incoming, type: incomingDisplayType ?? incoming.type } : undefined;
  const preview = displayedIncoming
    ? pinDefaultPreview(displayedIncoming, data, incomingConnected, pinTypeNames)
    : null;

  const isPending = (pin: SerializedPin | undefined) => Boolean(pin && pendingPinId === pin.id);

  const disabled = data.__disabled === true;

  return (
    <div
      data-pin-row
      className="flex w-full min-h-[var(--touch-target,44px)] min-w-max items-center justify-between gap-12"
    >
      <div
        className="flex shrink-0 items-center gap-1"
        data-pin-side={incoming ? "in" : undefined}
        data-pin-cell={incoming ? "" : undefined}
        data-pin-id={incoming?.id}
      >
        {incoming ? (
          <>
            <PinHandle
              nodeId={nodeId}
              pin={incoming}
              label={incomingHandleLabel}
              pending={isPending(incoming)}
              hasError={pinHasError(incoming.id)}
              connected={incomingConnected}
              disabled={disabled}
            />
            {preview && displayedIncoming ? <PinDefaultEditor
              nodeId={nodeId} nodeData={data} nodeType={typeof data.__nodeType === "string" ? data.__nodeType : undefined}
              connectedInputIds={connectedInputIds}
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
        data-pin-cell={outgoing ? "" : undefined}
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
              hasError={pinHasError(outgoing.id)}
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
 * the title, the breakpoint tab or a title-bar pin (it moves to the left edge when the node has one).
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

/** The previewed node's tag above its top-left corner (eye icon, host label), drawn at node scale like the error count. */
function NodePreviewTag({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute bottom-full left-0 z-10 flex pb-1.5" data-testid="graph-node-preview-tag">
      <span className="rounded-sm bg-graph-node shadow-md">
        <Badge variant="warning" size="lg" className="h-8 gap-1.5 text-sm has-data-[icon=inline-start]:pl-2 [&>svg]:size-4!">
          <EyeIcon data-icon="inline-start" aria-hidden="true" />
          {label}
        </Badge>
      </span>
    </span>
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

/** Pins drawn in the title bar rather than in a pin row. */
function headerPinsOf(data: Record<string, unknown> | undefined): SerializedPin[] {
  return hasSerializedPins(data) ? data.__pins.filter((pin) => pin.placement === "header") : [];
}

/**
 * A canvas waits a second before a node or pin description, so passing over nodes or working on them does not
 * open one. The debugger's value tips (`GraphRunOverlay`) open at once.
 */
const GRAPH_HINT_DELAY_MS = 1000;

/** A pin name with a `description` explains it as a tooltip (`LabelHint`). */
function PinHint({ pin, children }: { pin: SerializedPin; children: ReactElement }) {
  return pin.description ? <LabelHint hint={pin.description} delay={GRAPH_HINT_DELAY_MS}>{children}</LabelHint> : children;
}

export function BlueprintNodeShell({
  nodeId,
  title,
  role,
  kind,
  selected,
  data,
  children,
  card = false,
}: {
  nodeId: string;
  title: string;
  role: NodeVisualRole;
  /** The kind icon left of the title; none without it. */
  kind?: NodeKind;
  selected?: boolean;
  data?: Record<string, unknown>;
  children: ReactNode;
  /** Fixed-width flat card without the role title bar; children render their own header. */
  card?: boolean;
}) {
  const { describeNode, onNodeRenameCommit, onNodeRenameCancel } = useGraphEditorContext();
  const errorCount = useNodeErrorCount(nodeId);
  const previewed = usePreviewedNode(nodeId);
  const rename = useNodeRename(nodeId);
  const renaming = !card && rename.renaming;
  const titleGestures = useNodeTitleGestures(nodeId);
  const renameValue = rename.value ?? title;
  const headerColor = typeof data?.__headerColor === "string" && data.__headerColor ? data.__headerColor : undefined;
  const description = data ? describeNode?.(String(data.__nodeType ?? ""), data) : undefined;
  const developmentOnly = shellIsDevelopmentOnly(nodeId, data);
  const editorOnly = data?.__editorOnly === true;
  const disabled = data?.__disabled === true;
  const headerPins = card ? [] : headerPinsOf(data);

  return (
    <div className={cn("group/node relative", card && "group/title")}>
      <NodeErrorBadge nodeId={nodeId} count={errorCount} leading={headerPins.length > 0} />
      {previewed ? <NodePreviewTag label={previewed.label} /> : null}
      {/* Outside the shell, which clips its body to the rounded corners. */}
      <NodeBreakpointTab nodeId={nodeId} data={data} placement={card ? "cardTop" : "titleBar"} />
      <div
        data-node-role={role}
        data-disabled={disabled ? "true" : undefined}
        data-selected={card ? (selected ? "true" : "false") : undefined}
        className={cn(
          "overflow-hidden border border-border bg-graph-node text-card-foreground shadow-sm",
          card
            ? "graph-card-node w-56 rounded-md"
            : cn(
              "w-max min-w-80 rounded-lg",
              // A previewed node keeps its warning ring; selection then draws outside it.
              previewed ? cn("ring-2 ring-(--warning)", selected && "outline-2 outline-offset-2 outline-primary") : selected && "ring-2 ring-primary",
            ),
          disabled && "opacity-50",
        )}
      >
        {card ? null : (
          <div
            data-node-title=""
            className={cn(
              "group/title relative flex items-center gap-2 rounded-t-lg py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title",
              kind ? "pl-3 pr-4" : "px-4",
              headerPins.length > 0 && "pr-12",
              headerColor ? undefined : nodeRoleClass(role),
            )}
            style={headerColor ? { backgroundColor: headerColor, color: headerContrastColor(headerColor) } : undefined}
            data-header-color={headerColor ? "" : undefined}
            {...(renaming ? undefined : titleGestures)}
          >
            {kind ? <NodeKindIcon kind={kind} className="size-5" /> : null}
            {renaming ? (
              <NodeRenameField
                title={renameValue}
                onDone={(name) => {
                  if (name === null) onNodeRenameCancel?.();
                  else onNodeRenameCommit?.(nodeId, name);
                }}
              />
            ) : description ? (
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
  const nodeMenu = useNodeMenu(id);
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const { title, role, kind } = visualFromData(data, type);
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
          <div className="anim-state-node-title">
            <NodeKindIcon kind={kind} className="size-4" />
            <span>{title}</span>
          </div>
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
        kind={kind}
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
          <NodeAddPinButton nodeId={id} data={data} />
        </div>
        <NodeBody nodeId={id} data={data} />
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
  const pendingPinId = usePendingPinId(id);
  const pinHasError = usePinErrors(id);
  const errorCount = useNodeErrorCount(id);
  const dataPins = pins.filter((pin) => pin.kind !== "exec");
  const incoming = dataPins.filter((pin) => pin.direction === "in");
  const outgoing = dataPins.find((pin) => pin.direction === "out");
  const outgoingDisplayType = usePinDisplayType(id, outgoing?.id ?? "");
  const valueType = outgoing
    ? (outgoingDisplayType ?? outgoing.type)
    : { kind: "wildcard" };
  const disabled = data.__disabled === true;
  const nodeMenu = useNodeMenu(id);

  const isPending = (pin: SerializedPin) => pendingPinId === pin.id;

  return (
    <div className="relative" {...nodeMenu.bind}>
      <NodeErrorBadge nodeId={id} count={errorCount} />
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
          <WiredPinHandle
            key={pin.id}
            nodeId={id}
            pin={pin}
            pending={isPending(pin)}
            hasError={pinHasError(pin.id)}
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
            <WiredPinHandle
              nodeId={id}
              pin={outgoing}
              pending={isPending(outgoing)}
              hasError={pinHasError(outgoing.id)}
              disabled={disabled}
            />
          </>
        ) : null}
      </div>
      {nodeMenu.overlay}
    </div>
  );
}

/**
 * A Reroute knot: a small pill with no title bar, its input pin at the left end and its output
 * at the right, both drawn in the type the knot carries. The space between them drags the knot.
 */
function RerouteNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const pendingPinId = usePendingPinId(id);
  const pinHasError = usePinErrors(id);
  const nodeMenu = useNodeMenu(id);
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const input = pins.find((pin) => pin.direction === "in");
  const output = pins.find((pin) => pin.direction === "out");
  const inputWired = useStore((state) => (input ? isPinWired(state.edges, id, input) : false));
  const outputWired = useStore((state) => (output ? isPinWired(state.edges, id, output) : false));
  const isPending = (pin: SerializedPin) => pendingPinId === pin.id;
  // The outline takes the colour of what the knot carries, as its pins do (the input's, should they differ).
  const carried = input ?? output;
  const carriedDisplayType = usePinDisplayType(id, carried?.id ?? "");
  const outline = pinCssVar((carried && carriedDisplayType) ?? carried?.type ?? { kind: "wildcard" });
  const handle = (pin: SerializedPin, connected: boolean) => (
    <span className="flex" data-pin-side={pin.direction} data-pin-id={pin.id}>
      <PinHandle
        nodeId={id}
        pin={pin}
        pending={isPending(pin)}
        hasError={pinHasError(pin.id)}
        connected={connected}
        circle
      />
    </span>
  );
  return (
    <div {...nodeMenu.bind}>
      <div
        role="group"
        aria-label="Reroute"
        data-node-kind="reroute"
        data-selected={selected ? "true" : undefined}
        className={cn(
          "graph-reroute-knot flex items-center justify-between rounded-full border bg-graph-node shadow-sm",
          selected && "outline-2 outline-offset-2 outline-primary",
        )}
        // A 3px outline that keeps the knot's size: the 1px border plus a 2px inset ring, both in the carried colour.
        style={{ borderColor: outline, boxShadow: `inset 0 0 0 2px ${outline}` }}
      >
        {input ? handle(input, inputWired) : null}
        {output ? handle(output, outputWired) : null}
      </div>
      {nodeMenu.overlay}
    </div>
  );
}

/**
 * A Math Expression node: a card in the style of an Animation Graph state, its formula in monospace
 * under the title and its variables as ordinary pin rows, inputs left and outputs right. A
 * double-click, a double-tap, or Enter while the node is selected types the formula in place.
 */
function MathExpressionNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { onFormulaCommit } = useGraphEditorContext();
  const errorCount = useNodeErrorCount(id);
  const nodeMenu = useNodeMenu(id);
  const pins = hasSerializedPins(data) ? data.__pins : [];
  const rows = zipPinRows(pins);
  const formula = typeof data.formula === "string" ? data.formula : "";
  const { error } = mathExpressionNodeState(data);
  const disabled = data.__disabled === true;
  const editable = Boolean(onFormulaCommit) && !disabled;
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const startEditing = useCallback(() => { if (editable) setEditing(true); }, [editable]);
  const onTap = useDoubleTap(startEditing);
  // Pins come and go with the formula: re-measure the handles.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleOrder = pins.map((pin) => `${pin.direction}:${pin.id}`).join("|");
  const measured = useRef(handleOrder);
  useEffect(() => {
    if (measured.current === handleOrder) return;
    measured.current = handleOrder;
    updateNodeInternals(id);
  }, [handleOrder, id, updateNodeInternals]);
  // Enter on the selected node (React Flow focuses its wrapper) starts typing.
  useEffect(() => {
    const wrapper = cardRef.current?.closest(".react-flow__node");
    if (!selected || editing || !editable || !(wrapper instanceof HTMLElement)) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || event.target !== wrapper || event.repeat) return;
      event.preventDefault();
      setEditing(true);
    };
    wrapper.addEventListener("keydown", onKeyDown);
    return () => wrapper.removeEventListener("keydown", onKeyDown);
  }, [editable, editing, selected]);
  // Gestures on pins, their value fields and the open formula field are theirs.
  const onBody = (target: EventTarget | null) =>
    target instanceof Element && target.closest(".react-flow__handle, input, textarea, button, [data-pin-cell]") === null;
  return (
    <div {...nodeMenu.bind}>
      <div className="group/node group/title relative">
        <NodeErrorBadge nodeId={id} count={errorCount} />
        <NodeBreakpointTab nodeId={id} data={data} placement="cardTop" />
        <div
          ref={cardRef}
          className={cn("math-expression-node", selected && "anim-state-node-selected", disabled && "opacity-50")}
          data-node-kind="math-expression"
          data-disabled={disabled ? "true" : undefined}
          data-testid={`math-expression-${id}`}
          onDoubleClick={(event) => {
            if (!editable || !onBody(event.target)) return;
            event.stopPropagation();
            startEditing();
          }}
          onPointerUp={(event) => {
            if (onBody(event.target)) onTap(event);
          }}
        >
          <div className="anim-state-node-title math-expression-node-title">
            <NodeKindIcon kind="pure" className="size-4" />
            <span>Math Expression</span>
          </div>
          <div className="math-expression-node-formula">
            {editing ? (
              <MathExpressionFormulaField
                value={formula}
                onDone={(next) => {
                  setEditing(false);
                  if (next !== null && next !== formula) onFormulaCommit?.(id, next);
                }}
              />
            ) : (
              <pre data-testid="math-expression-formula" className={cn(!formula && "text-muted-foreground")}>
                {formula || "No Formula"}
              </pre>
            )}
          </div>
          {error && !editing ? (
            <div role="alert" className="math-expression-node-error" data-testid="math-expression-error">
              {`Line ${error.line}, column ${error.column}: ${error.message}`}
            </div>
          ) : null}
          {rows.length > 0 ? (
            <div className="flex flex-col py-1">
              {rows.map((row, index) => (
                <PinRow key={row.in?.id ?? row.out?.id ?? `row-${index}`} nodeId={id} data={data} incoming={row.in} outgoing={row.out} literalLabels />
              ))}
            </div>
          ) : null}
        </div>
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
  if (isRerouteNodeData(data) && "reroute" in knownTypes) return "reroute";
  const typeId = typeof data.__nodeType === "string" ? data.__nodeType : type;
  if (typeId === "variables.get" || typeId.startsWith("variables.get:")) {
    return "variableGet";
  }
  if (typeId === MATH_EXPRESSION_NODE_ID && "mathExpression" in knownTypes) return "mathExpression";
  if (type in knownTypes) return type;
  return "pinNode";
}

export const graphNodeTypes = {
  pinNode: PinNode,
  variableGet: VariableGetNode,
  reroute: RerouteNode,
  mathExpression: MathExpressionNode,
};
