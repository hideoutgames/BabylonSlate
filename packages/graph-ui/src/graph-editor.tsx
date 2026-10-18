import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  getViewportForBounds,
  useReactFlow,
  useStore,
  useStoreApi,
  type Connection,
  type DefaultEdgeOptions,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type InternalNode,
  type NodeChange,
  type NodeTypes,
  type OnConnectStartParams,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph-editor.css";
import { GraphViewportControls } from "./graph-viewport-controls";
import { GraphInteractionSettingsContext, NodeShakeTracker } from "./graph-interaction-settings";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { pinDefaultPropertyKey } from "@babylonslate/scripting";
import { PinDefaultEditorContext, type PinDefaultEditorRenderer } from "./pin-default-editor-context";
import { inlinePinDefaultStorageValue } from "./pin-default-value";
import { ClipboardPasteIcon, CopyIcon, PlusIcon, Trash2Icon, UnlinkIcon, WaypointsIcon } from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import { Separator } from "@babylonslate/ui/components/separator";
import { IslandIconButton } from "./island-icon-button";
import {
  AssetOpenProvider,
  ContextMenuOverlay,
  normalizeChord,
  useContextMenu,
  useEditorReadOnly,
  type NestedMenuItem,
} from "@babylonslate/editor-kit";
import {
  hasSerializedPins,
  type GraphDiagnostic,
  type GraphDocument,
  type NavigateRequest,
  type PaletteNode,
  type SerializedPin,
} from "./graph-types";
import type { PinTypeNames } from "./pin-default-preview";
import { animTransitionEdgeMarkers } from "./anim-transition-markers";
import { GraphEditorProvider } from "./graph-editor-context";
import {
  canonicalGraphSignature,
  createEdgeId,
  deletableNodeIds,
  graphChangeKindFromNodeChanges,
  isProtectedNode,
  isDisabledNode,
  lockNodeDragAxis,
  allocateGraphDragTransaction,
  nodeChangesMutateGraph,
  replaceChangesAsSelection,
  reconcileCanvasGraph,
  shouldEmitNodeChanges,
  toSerializedGraph,
  type GraphChangeMeta,
} from "./graph-model";
import {
  type CanvasNode,
  graphNodeTypes,
  resolveNodeType,
} from "./graph-nodes";
import { styleFlowEdges } from "./edge-style";
import { edgeStyleForPin } from "./node-theme";
import { NodePalette } from "./node-palette";
import { GraphConnectionLine } from "./connection-line";
import {
  collectDisplayConnectPins,
  connectEndAction,
  connectEventPointerId,
  containerPointerToClient,
  edgesAfterConnect,
  edgesTouchingNodes,
  edgeTouchesPin,
  firstCompatiblePin,
  isClientPointOverGraphNode,
  isClientPointOverHandle,
  nearestSnapConnectPin,
  finalizeOrientedConnection,
  pinRefusalReason,
  pinWithDisplayType,
  pinsAreCompatible,
  replacesExecOutputWire,
  screenPinsForSafeRefs,
  screenCentersForSafePins,
  type ConnectEndMode,
  type PinCompatibilityRule,
  type OrientedConnection,
  shouldOpenAddNodeOnConnectEnd,
  shouldCancelConnectOnSecondaryPointer,
  shouldCancelConnectionOnSecondaryPointer,
} from "./graph-connect";
import {
  createPinDisplayNodesSelector,
  displayPinTypesForGraph,
  pinTypeKey,
  type PinDisplayLookup,
} from "./wildcard-display";
import {
  GRAPH_DEFAULT_ZOOM,
  resolveGraphMountViewport,
  resolveGraphViewport,
  type GraphViewport,
} from "./graph-viewport";
import { formatGraphNodes } from "./graph-format";
import { freeNodePosition } from "./graph-placement";
import { findProximityConnections, type ProximityPin } from "./graph-proximity";
import {
  GRAPH_VIRTUALIZE_OVERSCAN_PX,
  estimateGraphNodeSize,
  graphNodesBounds,
  selectVisibleGraphElements,
} from "./graph-virtualize";
import {
  attachGraphPaneMarquee,
  flowRectFromPoints,
  nodesIntersectingMarquee,
} from "./graph-marquee";
import {
  createGraphCanvasDropApi,
  type GraphCanvasDropApi,
} from "./graph-canvas-api";
import {
  GraphKeybindsContext,
  graphCommandForEvent,
  type GraphCommand,
  type GraphKeybinds,
} from "./graph-keybinds";

export type { GraphDocument, GraphDiagnostic, NavigateRequest, PaletteNode };
export type { SerializedPin } from "./graph-types";
export type { PinTypeNames } from "./pin-default-preview";
export {
  GRAPH_DEFAULT_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_MIN_ZOOM,
  GRAPH_ZOOM_ON_DOUBLE_CLICK,
  resolveGraphMountViewport,
} from "./graph-viewport";
export { selectVisibleGraphElements } from "./graph-virtualize";

export interface GraphEditorProps {
  renderNodeBody?: (nodeId: string, data: Record<string, unknown>) => React.ReactNode;
  /** Catalog-backed literal editors. Defaults to PinDefaultEditorContext. */
  renderPinDefaultEditor?: PinDefaultEditorRenderer;
  initialGraph: GraphDocument;
  onChange?: (graph: GraphDocument, meta?: GraphChangeMeta) => void;
  /**
   * Keep node positions local while a drag is in flight and emit once on
   * pointer up. Material graphs use this so layout does not dirty every frame.
   */
  commitPositionsOnDragEnd?: boolean;
  /** Selected canvas node ids; not part of the serialized graph. */
  onSelectionChange?: (nodeIds: string[]) => void;
  /** Pin click in read-only previews (does not mutate). */
  onPinSelect?: (nodeId: string, pinId: string) => void;
  /** Highlight a node without fit-view (host list selection). */
  selectedNodeId?: string;
  focusedNodeId?: string;
  diagnostics?: GraphDiagnostic[];
  onNavigateRequest?: (request: NavigateRequest) => void;
  /** Double-tap / double-click a node (task class navigation). */
  onNodeDoubleClick?: (nodeId: string) => void;
  /** Double-click an edge (Animation Graph transition rules). */
  onEdgeDoubleClick?: (edgeId: string) => void;
  /** Selected canvas edge ids; not part of the serialized graph. */
  onEdgeSelectionChange?: (edgeIds: string[]) => void;
  paletteNodes?: PaletteNode[];
  /** Host can defer heavy injector generation until Add Node is open. */
  onPaletteOpenChange?: (open: boolean) => void;
  colorMode?: "light" | "dark";
  defaultZoom?: number;
  /** Restore pan/zoom after workspace remount; skips the mount `fitView`. */
  sessionViewport?: { x: number; y: number; zoom: number } | null;
  onSessionViewportChange?: (viewport: {
    x: number;
    y: number;
    zoom: number;
  }) => void;
  /** Pan/zoom only: no connect, node drag, palette, or Cut/Paste/Delete/Format. */
  readOnly?: boolean;
  /** Locks inline values without disabling node movement or graph connections. */
  readOnlyPinDefaults?: boolean;
  /** Override or extend the default pin/log node components. */
  nodeTypes?: NodeTypes;
  edgeTypes?: EdgeTypes;
  defaultEdgeOptions?: DefaultEdgeOptions;
  /** Defaults to `!readOnly`. Behaviour trees pass false during Play. */
  nodesDraggable?: boolean;
  toolbarExtra?: ReactNode;
  selectedAttachmentId?: string | null;
  onAttachmentSelect?: (id: string | null) => void;
  hiddenToolbarActions?: Array<"copy" | "paste" | "delete" | "breakLinks" | "format">;
  /** Lock node drag to one axis (optional host constraint). */
  lockNodeDragAxis?: "x" | "y";
  /**
   * CSS selector stamped onto each XYFlow node as `dragHandle`.
   * XYFlow 12 has no canvas-level `nodeDragHandle` prop. Attachments can use
   * `nodrag`.
   */
  nodeDragHandle?: string;
  /**
   * Connect-end policy. Default opens Add Node on a far empty-canvas drop
   * and keeps the 96px near-pin wire-break. Behaviour trees use `add-node`
   * so a short drag off a handle opens Add Node and never breaks structural
   * edges. Animation Graph State Machine uses `zone-add-node` (far release
   * opens Add State; near tap/release cancels without breaking transitions).
   */
  connectEndMode?: ConnectEndMode;
  /** Replace existing edges into the same target handle (tree parent pin). */
  replaceIncomingOnConnect?: boolean;
  /** One visual edge per source→target pair (Animation Graph transitions). */
  uniqueDirectedPairOnConnect?: boolean;
  /**
   * Scripting graphs: each exec output drives exactly one wire (exec inputs
   * still accept many), so a new wire from a linked exec output replaces it.
   */
  singleExecOutputOnConnect?: boolean;
  /** Extra host connection veto after pin compatibility. */
  canConnect?: (connection: {
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
  }) => boolean;
  /** Rewrite handle ids before validation / connect (Animation Graph sides). */
  normalizeConnection?: (connection: Connection) => Connection | null;
  /** React Flow connection mode. Animation Graph uses Loose for side handles. */
  connectionMode?: "strict" | "loose";
  /**
   * Keys that delete the selection (default: the Delete keybind, Delete and
   * Backspace unless rebound) while this graph was the last surface pressed or
   * focused. Behaviour trees pass null to avoid Delete trapping chrome.
   */
  deleteKeyCode?: string | string[] | null;
  /** Forwarded to React Flow. Default true; BT passes false to avoid focus traps. */
  nodesFocusable?: boolean;
  /**
   * Host actions for a node's menu (Rename Event). Script-style nodes list them
   * above the graph's own Copy, Paste, Duplicate, Delete and Break Links.
   */
  contextMenuItemsForNode?: (nodeId: string) => NestedMenuItem[];
  contextMenuItemsForAttachment?: (
    nodeId: string,
    attachmentId: string,
  ) => NestedMenuItem[];
  onAttachmentDoubleClick?: (nodeId: string, attachmentId: string) => void;
  /** Host connection rule (material numeric conversion). Defaults to exact kinds. */
  pinCompatibility?: PinCompatibilityRule;
  /** Struct/enum guid → display name for on-node type fields. */
  pinTypeNames?: PinTypeNames;
  /** Registers client hit-test / flow conversion for Class-member drops. */
  onCanvasApi?: (api: GraphCanvasDropApi | null) => void;
}

const DOUBLE_TAP_MS = 350;
const PASTE_OFFSET = 40;
/** Long enough to read; the hint never blocks editing meanwhile. */
const WIRE_NOTICE_MS = 4000;
/** A stable default, so the menu and key handlers do not rebuild every render. */
const NO_HIDDEN_TOOLBAR_ACTIONS: NonNullable<GraphEditorProps["hiddenToolbarActions"]> = [];
const REPLACED_WIRE_NOTICE = "Replaced the existing wire. Use a Sequence to run several.";
/** Keys typed into these keep their meaning (text editing, menu navigation). */
const KEY_EXEMPT_TARGETS =
  'input, textarea, select, [contenteditable="true"], .nokey, [role="menu"], [role="listbox"], [role="combobox"]';

/** `base`, or `base-2`, `base-3`, … when a node already uses it. */
function uniqueNodeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const id = `${base}-${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Nudge a placement by `PASTE_OFFSET` steps until none of `positions` lands
 * on an existing node, so repeated pastes cascade.
 */
function nonOverlappingOffset(
  positions: ReadonlyArray<{ x: number; y: number }>,
  existing: ReadonlyArray<{ position: { x: number; y: number } }>,
): number {
  const overlaps = (offset: number) =>
    positions.some((position) =>
      existing.some(
        (node) =>
          Math.abs(node.position.x - (position.x + offset)) < PASTE_OFFSET &&
          Math.abs(node.position.y - (position.y + offset)) < PASTE_OFFSET,
      ),
    );
  let offset = PASTE_OFFSET;
  while (overlaps(offset)) offset += PASTE_OFFSET;
  return offset;
}

function asConnection(connection: Connection | Edge): Connection {
  return {
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle ?? null,
    targetHandle: connection.targetHandle ?? null,
  };
}

function orientThenNormalize(
  connection: Connection,
  nodes: CanvasNode[],
  normalizeConnection?: (connection: Connection) => Connection | null,
): Connection | null {
  const pinFor = (nodeId: string, pinId: string) =>
    pinOnNode(nodes, nodeId, pinId);
  const finalized = finalizeOrientedConnection(
    connection,
    pinFor,
    normalizeConnection
      ? (oriented) => {
          const next = normalizeConnection({
            ...connection,
            source: oriented.source,
            target: oriented.target,
            sourceHandle: oriented.sourceHandle,
            targetHandle: oriented.targetHandle,
          });
          if (
            !next?.source ||
            !next.target ||
            !next.sourceHandle ||
            !next.targetHandle
          ) {
            return null;
          }
          return {
            source: next.source,
            target: next.target,
            sourceHandle: next.sourceHandle,
            targetHandle: next.targetHandle,
          };
        }
      : undefined,
  );
  if (!finalized) return null;
  return {
    ...connection,
    source: finalized.source,
    target: finalized.target,
    sourceHandle: finalized.sourceHandle,
    targetHandle: finalized.targetHandle,
  };
}

function toFlowEdges(edges: GraphDocument["edges"]): Edge[] {
  return edges.map((edge) => {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      ...(edge.type ? { type: edge.type } : {}),
      ...animTransitionEdgeMarkers(edge.type),
    };
  });
}

function withDragHandle(node: CanvasNode, handle?: string): CanvasNode {
  if (!handle) {
    if (node.dragHandle === undefined) return node;
    const rest = { ...node };
    delete rest.dragHandle;
    return rest;
  }
  if (node.dragHandle === handle) return node;
  return { ...node, dragHandle: handle };
}

function toCanvasNodes(
  nodes: GraphDocument["nodes"],
  knownTypes: NodeTypes,
  dragHandle?: string,
): CanvasNode[] {
  return nodes.map((node) =>
    withDragHandle(
      {
        id: node.id,
        type: resolveNodeType(node.type, node.data, knownTypes),
        position: node.position,
        data: { ...node.data, __nodeType: node.type },
      },
      dragHandle,
    ),
  );
}

// Node arrays and pin lists are React state: replaced on change, never edited in
// place. A lookup builds its index once per array instead of scanning for each pin.
const nodeIndexes = new WeakMap<CanvasNode[], Map<string, CanvasNode>>();
const pinIndexes = new WeakMap<readonly SerializedPin[], Map<string, SerializedPin>>();

/** The first entry with each id, as `find` would answer. */
function indexById<T extends { id: string }>(entries: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of entries) if (!index.has(entry.id)) index.set(entry.id, entry);
  return index;
}

function pinOnNode(
  nodes: CanvasNode[],
  nodeId: string,
  pinId: string,
): SerializedPin | undefined {
  let nodeIndex = nodeIndexes.get(nodes);
  if (!nodeIndex) nodeIndexes.set(nodes, (nodeIndex = indexById(nodes)));
  const node = nodeIndex.get(nodeId);
  if (!hasSerializedPins(node?.data)) return undefined;
  const pins = node.data.__pins;
  let pinIndex = pinIndexes.get(pins);
  if (!pinIndex) pinIndexes.set(pins, (pinIndex = indexById(pins)));
  return pinIndex.get(pinId);
}

/** The pins of one node a dragged node can link to, at the node's `position`. */
function proximityPinsOf(
  node: CanvasNode,
  bounds: InternalNode["internals"]["handleBounds"],
  position: { x: number; y: number },
): ProximityPin[] {
  const pins: ProximityPin[] = [];
  const nodePins = hasSerializedPins(node.data) ? node.data.__pins : [];
  let pinIndex = pinIndexes.get(nodePins);
  if (!pinIndex) pinIndexes.set(nodePins, (pinIndex = indexById(nodePins)));
  for (const [direction, handles] of [
    ["out", bounds?.source],
    ["in", bounds?.target],
  ] as const) {
    for (const handle of handles ?? []) {
      if (!handle.id) continue;
      const pin = pinIndex.get(handle.id);
      if (!pin || pin.direction !== direction) continue;
      // Node assistance joins facing pins; custom top-down tree handles
      // and overlapping state-transition plates retain their own gestures.
      if (handle.position !== (direction === "out" ? Position.Right : Position.Left)) continue;
      const opposite = direction === "out" ? bounds?.target : bounds?.source;
      if (opposite?.some((other) => other.position === handle.position)) continue;
      pins.push({
        nodeId: node.id,
        pinId: handle.id,
        direction,
        x: position.x + handle.x + handle.width / 2,
        y: position.y + handle.y + handle.height / 2,
      });
    }
  }
  return pins;
}

// A node that is not being dragged keeps its object and measured handles for the whole
// drag, so its pins are worked out once instead of on every drag tick.
const stationaryPins = new WeakMap<
  CanvasNode,
  { bounds: InternalNode["internals"]["handleBounds"]; pins: ProximityPin[] }
>();

function stationaryProximityPins(
  node: CanvasNode,
  bounds: InternalNode["internals"]["handleBounds"],
): ProximityPin[] {
  const cached = stationaryPins.get(node);
  if (cached && cached.bounds === bounds) return cached.pins;
  const pins = proximityPinsOf(node, bounds, node.position);
  stationaryPins.set(node, { bounds, pins });
  return pins;
}

type GraphClip = { nodes: CanvasNode[]; edges: Edge[] };

type VisibleGraph = { nodes: CanvasNode[]; edges: Edge[] };
type VisibleGraphInputs = {
  nodes: CanvasNode[];
  edges: Edge[];
  keepIds: string[];
  width: number;
  height: number;
  x: number;
  y: number;
  zoom: number;
  result: VisibleGraph;
};

/** The same mounted nodes and edges, element for element. */
function sameVisibleGraph(left: VisibleGraph, right: VisibleGraph): boolean {
  return (
    left === right ||
    (left.nodes.length === right.nodes.length &&
      left.edges.length === right.edges.length &&
      left.nodes.every((node, index) => node === right.nodes[index]) &&
      left.edges.every((edge, index) => edge === right.edges[index]))
  );
}

function sameProximityPaths(
  left: ReadonlyArray<{ connection: OrientedConnection; path: string }>,
  right: ReadonlyArray<{ connection: OrientedConnection; path: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index]!;
      return (
        entry.path === other.path &&
        entry.connection.source === other.connection.source &&
        entry.connection.sourceHandle === other.connection.sourceHandle &&
        entry.connection.target === other.connection.target &&
        entry.connection.targetHandle === other.connection.targetHandle
      );
    })
  );
}

function overlayPin(
  pin: SerializedPin,
  nodeId: string,
  displayTypes: PinDisplayLookup,
): SerializedPin {
  return pinWithDisplayType(pin, displayTypes.get(pinTypeKey(nodeId, pin.id)));
}

function displayTypeLookup(displayTypes: PinDisplayLookup) {
  return (nodeId: string, pinId: string) =>
    displayTypes.get(pinTypeKey(nodeId, pinId));
}

function connectDragClientPoint(
  session: { pointer: { x: number; y: number } },
  connection: {
    inProgress: boolean;
    pointer?: { x: number; y: number } | null;
  },
  root: ParentNode = document,
): { x: number; y: number } {
  if (connection.inProgress && connection.pointer) {
    const flow = root.querySelector(".react-flow");
    return flow
      ? containerPointerToClient(connection.pointer, flow)
      : connection.pointer;
  }
  return session.pointer;
}

function clientPoint(
  event: MouseEvent | TouchEvent,
): { x: number; y: number } | null {
  if ("changedTouches" in event && event.changedTouches[0]) {
    return {
      x: event.changedTouches[0].clientX,
      y: event.changedTouches[0].clientY,
    };
  }
  if ("clientX" in event) {
    return { x: event.clientX, y: event.clientY };
  }
  return null;
}

/** The same edges with no wire selected; unchanged when none was. */
function withoutEdgeSelection(edges: Edge[]): Edge[] {
  return edges.some((edge) => edge.selected)
    ? edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge))
    : edges;
}

function SelectedNodeSync({ selectedNodeId }: { selectedNodeId?: string }) {
  const { setNodes, setEdges } = useReactFlow();
  const nodeExists = useStore((state) => !!selectedNodeId && state.nodeLookup.has(selectedNodeId));

  useEffect(() => {
    if (!selectedNodeId || !nodeExists) return;
    setNodes((current) => {
      const already =
        current.some((entry) => entry.id === selectedNodeId && entry.selected) &&
        current.every(
          (entry) => entry.id === selectedNodeId || !entry.selected,
        );
      if (already) return current;
      return current.map((entry) => ({
        ...entry,
        selected: entry.id === selectedNodeId,
      }));
    });
    setEdges(withoutEdgeSelection);
  }, [nodeExists, selectedNodeId, setEdges, setNodes]);

  return null;
}

function FocusedNodeSync({
  focusedNodeId,
  fitViewOptions,
}: {
  focusedNodeId?: string;
  fitViewOptions: GraphViewport["focusedFitViewOptions"];
}) {
  const { fitView, setEdges, setNodes } = useReactFlow();
  const nodeExists = useStore((state) => !!focusedNodeId && state.nodeLookup.has(focusedNodeId));
  const canFrame = useStore((state) => {
    const node = focusedNodeId ? state.nodeLookup.get(focusedNodeId) : undefined;
    return !!(node?.measured.width && node.measured.height && state.panZoom && state.width && state.height);
  });

  useEffect(() => {
    if (!focusedNodeId || !nodeExists) return;

    setNodes((current) =>
      current.map((entry) => ({
        ...entry,
        selected: entry.id === focusedNodeId,
      })),
    );
    // Like a canvas click: Break Links must not act on an earlier wire.
    setEdges(withoutEdgeSelection);
  }, [focusedNodeId, nodeExists, setEdges, setNodes]);

  useEffect(() => {
    if (!focusedNodeId || !canFrame) return;
    void fitView({
      nodes: [{ id: focusedNodeId }],
      ...fitViewOptions,
    });
  }, [canFrame, fitView, fitViewOptions, focusedNodeId]);

  return null;
}

function GraphEditorCanvas({
  initialGraph,
  onChange,
  commitPositionsOnDragEnd = false,
  onSelectionChange,
  selectedNodeId,
  focusedNodeId,
  diagnostics,
  onNavigateRequest,
  onNodeDoubleClick,
  onEdgeDoubleClick,
  renderNodeBody,
  renderPinDefaultEditor: renderPinDefaultEditorProp,
  onEdgeSelectionChange,
  paletteNodes,
  onPaletteOpenChange,
  colorMode = "dark",
  defaultZoom = GRAPH_DEFAULT_ZOOM,
  sessionViewport = null,
  onSessionViewportChange,
  readOnly: readOnlyProp = false,
  readOnlyPinDefaults: readOnlyPinDefaultsProp,
  onPinSelect,
  nodeTypes: nodeTypesProp,
  edgeTypes,
  defaultEdgeOptions = { type: "default" },
  nodesDraggable: nodesDraggableProp,
  toolbarExtra,
  selectedAttachmentId = null,
  onAttachmentSelect,
  hiddenToolbarActions = NO_HIDDEN_TOOLBAR_ACTIONS,
  lockNodeDragAxis: lockDragAxis,
  nodeDragHandle,
  connectEndMode = "default",
  replaceIncomingOnConnect = false,
  uniqueDirectedPairOnConnect = false,
  singleExecOutputOnConnect = false,
  canConnect,
  normalizeConnection,
  connectionMode,
  deleteKeyCode,
  nodesFocusable = true,
  contextMenuItemsForNode,
  contextMenuItemsForAttachment,
  onAttachmentDoubleClick,
  pinCompatibility,
  pinTypeNames,
  onCanvasApi,
}: GraphEditorProps) {
  const inheritedReadOnly = useEditorReadOnly();
  const readOnly = readOnlyProp || inheritedReadOnly;
  const knownTypes = useMemo(
    () => ({ ...graphNodeTypes, ...nodeTypesProp }),
    [nodeTypesProp],
  );
  const nodesDraggable = !readOnly && (nodesDraggableProp ?? true);
  const interactions = useContext(GraphInteractionSettingsContext);
  const keybinds = useContext(GraphKeybindsContext);
  const inheritedPinEditor = useContext(PinDefaultEditorContext);
  const renderPinDefaultEditor = renderPinDefaultEditorProp ?? inheritedPinEditor;
  const pinDefaultsDisabled = readOnly || (readOnlyPinDefaultsProp ?? interactions.readOnlyPinDefaults ?? false);
  const pinDefaultsDisabledRef = useRef(pinDefaultsDisabled);
  useLayoutEffect(() => {
    pinDefaultsDisabledRef.current = pinDefaultsDisabled;
  });
  const shakeTracker = useRef(new NodeShakeTracker());
  const shakenRef = useRef(false);
  const graphViewport = useMemo(
    () => resolveGraphViewport(defaultZoom),
    [defaultZoom],
  );
  const mountViewport = useMemo(
    () => resolveGraphMountViewport(sessionViewport, graphViewport),
    [graphViewport, sessionViewport],
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    toCanvasNodes(initialGraph.nodes, knownTypes, nodeDragHandle),
  );
  const [edges, setEdges] = useState<Edge[]>(() =>
    toFlowEdges(initialGraph.edges),
  );
  const connectedInputs = useMemo(() => {
    const inputs = new Map<string, string[]>();
    for (const edge of edges) {
      if (!edge.targetHandle) continue;
      const ids = inputs.get(edge.target) ?? [];
      ids.push(edge.targetHandle);
      inputs.set(edge.target, ids);
    }
    return inputs;
  }, [edges]);
  const [pendingPin, setPendingPin] = useState<{
    nodeId: string;
    pinId: string;
  } | null>(null);
  const pendingPinRef = useRef(pendingPin);
  useLayoutEffect(() => {
    pendingPinRef.current = pendingPin;
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const onPaletteOpenChangeRef = useRef(onPaletteOpenChange);
  useLayoutEffect(() => {
    onPaletteOpenChangeRef.current = onPaletteOpenChange;
  });
  const setPaletteOpenState = useCallback((next: boolean) => {
    setPaletteOpen(next);
    onPaletteOpenChangeRef.current?.(next);
  }, []);
  const [pendingConnect, setPendingConnect] = useState<{
    pin?: SerializedPin;
    nodeId?: string;
    position: { x: number; y: number };
  } | null>(null);
  const [paletteAnchor, setPaletteAnchor] = useState<{ x: number; y: number } | null>(null);
  const [paletteModal, setPaletteModal] = useState(false);
  const connectDragRef = useRef<{
    pointerId: number;
    pointer: { x: number; y: number };
    nodeId: string;
    pinId: string;
    connectEndHandled: boolean;
    connectCommitted: boolean;
  } | null>(null);
  const [marqueeScreen, setMarqueeScreen] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [marqueeArmed, setMarqueeArmed] = useState(false);
  const [hasClipboard, setHasClipboard] = useState(false);
  const clipboardRef = useRef<GraphClip | null>(null);
  // Counts replaced-wire hints, so a second one restarts the timer.
  const [wireNotice, setWireNotice] = useState(0);
  const noteReplacedWire = useCallback(() => setWireNotice((count) => count + 1), []);
  useEffect(() => {
    if (wireNotice === 0) return;
    const timer = setTimeout(() => setWireNotice(0), WIRE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [wireNotice]);
  const lastPaneTapRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const skipPaneClickRef = useRef(false);
  const membersRef = useRef(initialGraph.members);
  const componentsRef = useRef(initialGraph.components);
  useLayoutEffect(() => {
    membersRef.current = initialGraph.members;
    componentsRef.current = initialGraph.components;
  });
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const storeApi = useStoreApi();
  const graphStateRef = useRef({ nodes, edges });
  useLayoutEffect(() => {
    graphStateRef.current = { nodes, edges };
  });
  const proximityDragRef = useRef(false);
  const [proximityPaths, setProximityPaths] = useState<Array<{
    connection: OrientedConnection;
    path: string;
  }>>([]);
  const proximityPathsRef = useRef(proximityPaths);
  useLayoutEffect(() => {
    proximityPathsRef.current = proximityPaths;
  });
  const [selectPinDisplayNodes] = useState(createPinDisplayNodesSelector);
  const pinNodes = selectPinDisplayNodes(nodes);
  const pinDisplayTypes = useMemo(
    () => displayPinTypesForGraph(pinNodes, edges),
    [edges, pinNodes],
  );
  const pinDisplayTypesRef = useRef(pinDisplayTypes);
  // The graph the memo above resolved; commitGraph can advance graphStateRef
  // before the next commit, so reuse requires both to match by identity.
  const pinDisplaySourceRef = useRef({ nodes, edges, types: pinDisplayTypes });
  useLayoutEffect(() => {
    pinDisplayTypesRef.current = pinDisplayTypes;
    pinDisplaySourceRef.current = { nodes, edges, types: pinDisplayTypes };
  });
  const paneMenu = useContextMenu({
    items: [],
    enabled: Boolean(contextMenuItemsForNode) && !readOnly,
  });

  const errorDiagnostics = useMemo(
    () =>
      (diagnostics ?? []).filter(
        (entry) => entry.severity === "error" || entry.severity === "Error",
      ),
    [diagnostics],
  );

  const nodeErrorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of errorDiagnostics) {
      if (entry.nodeId) {
        counts.set(entry.nodeId, (counts.get(entry.nodeId) ?? 0) + 1);
      }
    }
    return counts;
  }, [errorDiagnostics]);
  const pinErrorKeys = useMemo(
    () =>
      new Set(
        errorDiagnostics.flatMap((entry) =>
          entry.nodeId && entry.pinId
            ? [`${entry.nodeId}\u0000${entry.pinId}`]
            : [],
        ),
      ),
    [errorDiagnostics],
  );
  const nodeErrorCount = useCallback(
    (nodeId: string) => nodeErrorCounts.get(nodeId) ?? 0,
    [nodeErrorCounts],
  );
  const pinHasError = useCallback(
    (nodeId: string, pinId: string) =>
      pinErrorKeys.has(`${nodeId}\u0000${pinId}`),
    [pinErrorKeys],
  );

  const lastEmittedRef = useRef<GraphDocument | null>(null);
  // Signature of `lastEmittedRef.current`, so an emit hashes only its new graph.
  const lastEmittedSignatureRef = useRef<{ graph: GraphDocument; signature: string } | null>(null);
  const dragTransactionRef = useRef<string | null>(null);

  const emitChange = useCallback(
    (
      nextNodes: CanvasNode[],
      nextEdges: Edge[],
      meta: GraphChangeMeta = { kind: "graph" },
    ) => {
      const graph = toSerializedGraph(
        nextNodes,
        nextEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          ...(typeof edge.type === "string" ? { type: edge.type } : {}),
        })),
        { members: membersRef.current, components: componentsRef.current },
      );
      const last = lastEmittedRef.current;
      if (last) {
        const signature = canonicalGraphSignature(graph);
        let previous = lastEmittedSignatureRef.current;
        if (previous?.graph !== last) {
          previous = { graph: last, signature: canonicalGraphSignature(last) };
          lastEmittedSignatureRef.current = previous;
        }
        if (signature === previous.signature) return;
        lastEmittedSignatureRef.current = { graph, signature };
      }
      lastEmittedRef.current = graph;
      onChange?.(graph, meta);
    },
    [onChange],
  );

  useEffect(() => {
    const next = reconcileCanvasGraph({
      localNodes: graphStateRef.current.nodes,
      localEdges: graphStateRef.current.edges,
      incoming: initialGraph,
      lastEmitted: lastEmittedRef.current,
    });
    if (!next) return;
    // Host refreshes can arrive during a drag. Discard the old suggestions,
    // but let the next movement discover pins against the refreshed graph.
    proximityPathsRef.current = [];
    setProximityPaths([]);
    lastEmittedRef.current = initialGraph;
    setNodes(
      next.nodes.map((node) => {
        const data = {
          ...((node.data ?? {}) as Record<string, unknown>),
        };
        if (typeof data.__nodeType !== "string" && node.type) {
          data.__nodeType = node.type;
        }
        const typeId =
          typeof data.__nodeType === "string" ? data.__nodeType : (node.type ?? "");
        return withDragHandle(
          {
            id: node.id,
            type: resolveNodeType(typeId, data, knownTypes),
            position: node.position,
            data,
            selected: node.selected,
            measured: node.measured,
            width: node.width,
            height: node.height,
          },
          nodeDragHandle,
        );
      }),
    );
    setEdges(
      toFlowEdges(
        next.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
          ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
          ...(edge.type ? { type: edge.type } : {}),
        })),
      ),
    );
  }, [initialGraph, knownTypes, nodeDragHandle]);

  // Re-apply a changed drag handle selector while rendering.
  const [appliedDragHandle, setAppliedDragHandle] = useState(nodeDragHandle);
  if (appliedDragHandle !== nodeDragHandle) {
    setAppliedDragHandle(nodeDragHandle);
    setNodes((current) => {
      const next = current.map((node) => withDragHandle(node, nodeDragHandle));
      return next.every((node, index) => node === current[index])
        ? current
        : next;
    });
  }

  const hiddenToolbar = useMemo(
    () => new Set(hiddenToolbarActions),
    [hiddenToolbarActions],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => {
        const constrained = replaceChangesAsSelection(
          lockNodeDragAxis(changes, current, lockDragAxis),
        );
        const applied = readOnly
          ? constrained.filter(
              (change) => change.type === "select" || change.type === "dimensions",
            )
          : constrained;
        const next = applyNodeChanges(applied, current);
        const allocated = allocateGraphDragTransaction(
          dragTransactionRef.current,
          constrained,
          () => globalThis.crypto.randomUUID(),
        );
        dragTransactionRef.current = allocated.next;
        if (
          !readOnly &&
          shouldEmitNodeChanges(constrained, { commitPositionsOnDragEnd })
        ) {
          const kind = graphChangeKindFromNodeChanges(constrained);
          emitChange(next, graphStateRef.current.edges, {
            kind,
            ...(kind === "position" && allocated.id
              ? { transactionId: allocated.id }
              : {}),
          });
        }
        return next;
      });
    },
    [commitPositionsOnDragEnd, emitChange, lockDragAxis, readOnly],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const effective = replaceChangesAsSelection(changes);
      // Read-only canvases still select wires, as they select nodes.
      const applied = readOnly
        ? effective.filter((change) => change.type === "select")
        : effective;
      if (applied.length === 0) return;
      setEdges((current) => {
        const next = applyEdgeChanges(applied, current);
        if (!readOnly && nodeChangesMutateGraph(applied)) {
          emitChange(graphStateRef.current.nodes, next);
        }
        return next;
      });
    },
    [emitChange, readOnly],
  );

  // Writes both sides at once, so a handler running before the next commit
  // sees this edit rather than the last rendered graph.
  const commitGraph = useCallback(
    (nextNodes: CanvasNode[], nextEdges: Edge[]) => {
      graphStateRef.current = { nodes: nextNodes, edges: nextEdges };
      setNodes(nextNodes);
      setEdges(nextEdges);
      emitChange(nextNodes, nextEdges);
    },
    [emitChange],
  );

  const addEdge = useCallback(
    (
      source: string,
      sourceHandle: string,
      target: string,
      targetHandle: string,
    ) => {
      const sourceNode = graphStateRef.current.nodes.find(
        (node) => node.id === source,
      );
      const targetNode = graphStateRef.current.nodes.find(
        (node) => node.id === target,
      );
      if (
        (sourceNode && isDisabledNode(sourceNode)) ||
        (targetNode && isDisabledNode(targetNode))
      ) {
        return;
      }
      const id = createEdgeId(source, sourceHandle, target, targetHandle);
      if (
        singleExecOutputOnConnect &&
        replacesExecOutputWire(
          graphStateRef.current.edges,
          { source, sourceHandle, target, targetHandle },
          (nodeId, pinId) =>
            pinOnNode(graphStateRef.current.nodes, nodeId, pinId),
        )
      ) {
        noteReplacedWire();
      }
      setEdges((current) => {
        const next = edgesAfterConnect(
          current,
          {
            id,
            source,
            target,
            sourceHandle,
            targetHandle,
            ...(defaultEdgeOptions.type
              ? { type: defaultEdgeOptions.type }
              : {}),
          },
          (nodeId, pinId) =>
            pinOnNode(graphStateRef.current.nodes, nodeId, pinId),
          { replaceIncoming: replaceIncomingOnConnect, uniqueDirectedPair: uniqueDirectedPairOnConnect, singleExecOutput: singleExecOutputOnConnect },
        );
        const unchanged =
          next.length === current.length &&
          next.every((edge, index) => {
            const prev = current[index];
            return (
              prev !== undefined &&
              edge.id === prev.id &&
              edge.source === prev.source &&
              edge.target === prev.target &&
              (edge.sourceHandle ?? "") === (prev.sourceHandle ?? "") &&
              (edge.targetHandle ?? "") === (prev.targetHandle ?? "")
            );
          });
        if (unchanged) return current;
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
    },
    [
      defaultEdgeOptions.type,
      emitChange,
      noteReplacedWire,
      replaceIncomingOnConnect,
      uniqueDirectedPairOnConnect,
      singleExecOutputOnConnect,
    ],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const incoming = asConnection(connection);
      const next = orientThenNormalize(
        incoming,
        graphStateRef.current.nodes,
        normalizeConnection,
      );
      if (
        !next?.source ||
        !next.target ||
        !next.sourceHandle ||
        !next.targetHandle
      ) {
        return false;
      }
      const sourcePin = pinOnNode(
        graphStateRef.current.nodes,
        next.source,
        next.sourceHandle,
      );
      const targetPin = pinOnNode(
        graphStateRef.current.nodes,
        next.target,
        next.targetHandle,
      );
      if (!sourcePin || !targetPin) return true;
      const sourceNode = graphStateRef.current.nodes.find(
        (node) => node.id === next.source,
      );
      const targetNode = graphStateRef.current.nodes.find(
        (node) => node.id === next.target,
      );
      if (
        (sourceNode && isDisabledNode(sourceNode)) ||
        (targetNode && isDisabledNode(targetNode))
      ) {
        return false;
      }
      const displayTypes = pinDisplayTypesRef.current;
      if (
        !pinsAreCompatible(
          overlayPin(sourcePin, next.source, displayTypes),
          overlayPin(targetPin, next.target, displayTypes),
          pinCompatibility,
        )
      ) {
        return false;
      }
      if (!canConnect) return true;
      return canConnect({
        source: next.source,
        target: next.target,
        sourceHandle: next.sourceHandle,
        targetHandle: next.targetHandle,
      });
    },
    [canConnect, normalizeConnection, pinCompatibility],
  );

  // Read while a dragged wire hovers a pin XYFlow reports as invalid; it names
  // the reason `isValidConnection` refused. Null when the wire is acceptable.
  const connectionRefusal = useCallback(
    (
      from: { nodeId: string; pinId: string },
      to: { nodeId: string; pinId: string },
    ): string | null => {
      const { nodes: current } = graphStateRef.current;
      const fromPin = pinOnNode(current, from.nodeId, from.pinId);
      const toPin = pinOnNode(current, to.nodeId, to.pinId);
      if (!fromPin || !toPin) return null;
      if (
        isValidConnection({
          source: from.nodeId,
          sourceHandle: from.pinId,
          target: to.nodeId,
          targetHandle: to.pinId,
        })
      ) {
        return null;
      }
      const disabled = (nodeId: string) => {
        const node = current.find((entry) => entry.id === nodeId);
        return node !== undefined && isDisabledNode(node);
      };
      if (disabled(from.nodeId) || disabled(to.nodeId)) {
        return "Disabled nodes don't connect";
      }
      const displayTypes = pinDisplayTypesRef.current;
      return (
        pinRefusalReason(
          overlayPin(fromPin, from.nodeId, displayTypes),
          overlayPin(toPin, to.nodeId, displayTypes),
          pinCompatibility,
          pinTypeNames,
        ) ?? "These pins can't connect"
      );
    },
    [isValidConnection, pinCompatibility, pinTypeNames],
  );

  const collectProximityConnections = useCallback(
    (dragged: CanvasNode[]) => {
      if (readOnly || !nodesDraggable || !proximityDragRef.current || !interactions.assistantEnabled || shakenRef.current) return [];
      // An already-linked single-link exec output is not an unused pin.
      const linksSingleExecOutput = (
        edge: { source: string; sourceHandle?: string | null },
        connection: { source: string; sourceHandle?: string | null },
      ) =>
        singleExecOutputOnConnect &&
        edge.source === connection.source &&
        (edge.sourceHandle ?? "") === (connection.sourceHandle ?? "") &&
        pinOnNode(graphStateRef.current.nodes, connection.source, connection.sourceHandle ?? "")?.kind === "exec";
      const moving = new Map(dragged.map((node) => [node.id, node]));
      const pins: ProximityPin[] = [];
      const store = storeApi.getState();
      for (const node of graphStateRef.current.nodes) {
        if (isDisabledNode(node)) continue;
        const internal = store.nodeLookup.get(node.id);
        if (!internal) continue;
        const bounds = internal.internals.handleBounds;
        const dragged = moving.get(node.id);
        const nodePins = dragged
          ? proximityPinsOf(node, bounds, dragged.position)
          : stationaryProximityPins(node, bounds);
        for (const pin of nodePins) pins.push(pin);
      }
      const connections = findProximityConnections({
        pins,
        edges: graphStateRef.current.edges,
        movingNodeIds: new Set(moving.keys()),
        maxDistance: interactions.assistantDistance / store.transform[2],
        resolveConnection: (connection) =>
          finalizeOrientedConnection(
            connection,
            (nodeId, pinId) =>
              pinOnNode(graphStateRef.current.nodes, nodeId, pinId),
            normalizeConnection
              ? (oriented) => {
                  const normalized = normalizeConnection(oriented);
                  return normalized?.sourceHandle && normalized.targetHandle
                    ? {
                        ...normalized,
                        sourceHandle: normalized.sourceHandle,
                        targetHandle: normalized.targetHandle,
                      }
                    : null;
                }
              : undefined,
          ),
        isValidConnection: (connection) => {
          // Assistance never invokes host replacement policies on existing wires.
          if (
            graphStateRef.current.edges.some(
              (edge) =>
                (replaceIncomingOnConnect &&
                  edge.target === connection.target) ||
                (uniqueDirectedPairOnConnect &&
                  edge.source === connection.source &&
                  edge.target === connection.target) ||
                linksSingleExecOutput(edge, connection),
            )
          )
            return false;
          return isValidConnection(connection);
        },
      });
      // Resolve the whole proposed batch, so two unused pins in one wildcard
      // group cannot preview mutually incompatible types.
      const savedDisplayTypes = pinDisplayTypesRef.current;
      let proposedEdges = graphStateRef.current.edges;
      // Wildcards are resolved again only after a suggestion is accepted.
      let resolvedEdges: Edge[] | null = null;
      const accepted: OrientedConnection[] = [];
      try {
        for (const connection of connections) {
          if (resolvedEdges !== proposedEdges) {
            const rendered = pinDisplaySourceRef.current;
            pinDisplayTypesRef.current =
              rendered.nodes === graphStateRef.current.nodes &&
              rendered.edges === proposedEdges
                ? rendered.types
                : displayPinTypesForGraph(
                    graphStateRef.current.nodes,
                    proposedEdges,
                  );
            resolvedEdges = proposedEdges;
          }
          if (!isValidConnection(connection)) continue;
          if (
            proposedEdges.some(
              (edge) =>
                (replaceIncomingOnConnect &&
                  edge.target === connection.target) ||
                (uniqueDirectedPairOnConnect &&
                  edge.source === connection.source &&
                  edge.target === connection.target) ||
                linksSingleExecOutput(edge, connection),
            )
          )
            continue;
          proposedEdges = [
            ...proposedEdges,
            {
              ...connection,
              id: createEdgeId(
                connection.source,
                connection.sourceHandle,
                connection.target,
                connection.targetHandle,
              ),
            },
          ];
          accepted.push(connection);
        }
      } finally {
        pinDisplayTypesRef.current = savedDisplayTypes;
      }
      return accepted.map((connection) => {
        const source = pins.find(
          (pin) =>
            pin.nodeId === connection.source &&
            pin.pinId === connection.sourceHandle,
        )!;
        const target = pins.find(
          (pin) =>
            pin.nodeId === connection.target &&
            pin.pinId === connection.targetHandle,
        )!;
        return {
          connection,
          path: getBezierPath({
            sourceX: source.x,
            sourceY: source.y,
            sourcePosition: Position.Right,
            targetX: target.x,
            targetY: target.y,
            targetPosition: Position.Left,
          })[0],
        };
      });
    },
    [
      isValidConnection,
      interactions,
      nodesDraggable,
      normalizeConnection,
      readOnly,
      replaceIncomingOnConnect,
      storeApi,
      uniqueDirectedPairOnConnect,
      singleExecOutputOnConnect,
    ],
  );

  const cancelProximityConnections = useCallback(() => {
    proximityDragRef.current = false;
    shakenRef.current = false;
    proximityPathsRef.current = [];
    setProximityPaths([]);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelProximityConnections();
    };
    const onVisibilityChange = () => {
      if (document.hidden) cancelProximityConnections();
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length > 1) cancelProximityConnections();
    };
    window.addEventListener("blur", cancelProximityConnections);
    document.addEventListener(
      "pointercancel",
      cancelProximityConnections,
      true,
    );
    document.addEventListener("touchcancel", cancelProximityConnections, true);
    document.addEventListener("touchstart", onTouchStart, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", cancelProximityConnections);
      document.removeEventListener(
        "pointercancel",
        cancelProximityConnections,
        true,
      );
      document.removeEventListener(
        "touchcancel",
        cancelProximityConnections,
        true,
      );
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cancelProximityConnections]);

  // Locking the canvas drops proximity suggestions: state while rendering,
  // drag bookkeeping once committed.
  const proximityLocked = readOnly || !nodesDraggable;
  if (proximityLocked && proximityPaths.length > 0) setProximityPaths([]);
  useEffect(() => {
    if (!proximityLocked) return;
    proximityDragRef.current = false;
    shakenRef.current = false;
    proximityPathsRef.current = [];
  }, [proximityLocked]);

  const handleNodeDrag: OnNodeDrag<CanvasNode> = useCallback(
    (_event, node, dragged) => {
      const moving = dragged.length ? dragged : [node];
      const zoom = storeApi.getState().transform[2];
      if (
        interactions.shakeEnabled && !readOnly && nodesDraggable &&
        proximityDragRef.current && !shakenRef.current &&
        shakeTracker.current.move(node.position.x * zoom, node.position.y * zoom, performance.now())
      ) {
        // Disconnect as soon as the gesture crosses the threshold, and keep
        // assistance suppressed until release so these pins stay disconnected.
        shakenRef.current = true;
        const ids = new Set(moving.map((entry) => entry.id));
        const nextEdges = graphStateRef.current.edges.filter(
          (edge) => !ids.has(edge.source) && !ids.has(edge.target),
        );
        if (nextEdges.length !== graphStateRef.current.edges.length) {
          const positions = new Map(moving.map((entry) => [entry.id, entry.position]));
          const nextNodes = graphStateRef.current.nodes.map((entry) =>
            positions.has(entry.id) ? { ...entry, position: positions.get(entry.id)! } : entry,
          );
          commitGraph(nextNodes, nextEdges);
        }
      }
      const paths = collectProximityConnections(moving);
      // A drag tick with the same suggestions (usually none) must not render the editor again.
      const unchanged = sameProximityPaths(proximityPathsRef.current, paths);
      proximityPathsRef.current = paths;
      if (!unchanged) setProximityPaths(paths);
    },
    [collectProximityConnections, commitGraph, interactions.shakeEnabled, nodesDraggable, readOnly, storeApi],
  );

  const handleNodeDragStop: OnNodeDrag<CanvasNode> = useCallback(
    (_event, node, dragged) => {
      const moving = dragged.length ? dragged : [node];
      if (shakenRef.current && interactions.shakeEnabled && !readOnly && nodesDraggable) {
        const nextEdges = graphStateRef.current.edges;
        const positions = new Map(moving.map((entry) => [entry.id, entry.position]));
        const nextNodes = graphStateRef.current.nodes.map((entry) => positions.has(entry.id) ? { ...entry, position: positions.get(entry.id)! } : entry);
        cancelProximityConnections();
        commitGraph(nextNodes, nextEdges);
        return;
      }
      const previewed = new Set(
        proximityPathsRef.current.map(({ connection }) =>
          createEdgeId(
            connection.source,
            connection.sourceHandle,
            connection.target,
            connection.targetHandle,
          ),
        ),
      );
      const candidates = collectProximityConnections(moving).filter(
        ({ connection }) =>
          previewed.has(
            createEdgeId(
              connection.source,
              connection.sourceHandle,
              connection.target,
              connection.targetHandle,
            ),
          ),
      );
      cancelProximityConnections();
      if (!candidates.length) return;
      const positions = new Map(
        moving.map((entry) => [entry.id, entry.position]),
      );
      const nextNodes = graphStateRef.current.nodes.map((entry) =>
        positions.has(entry.id)
          ? { ...entry, position: positions.get(entry.id)! }
          : entry,
      );
      let nextEdges = graphStateRef.current.edges;
      const previousEdges = nextEdges;
      let resolvedEdges: Edge[] | null = null;
      for (const { connection } of candidates) {
        // Earlier accepted pins may resolve wildcard groups for later suggestions.
        if (resolvedEdges !== nextEdges) {
          pinDisplayTypesRef.current = displayPinTypesForGraph(
            nextNodes,
            nextEdges,
          );
          resolvedEdges = nextEdges;
        }
        if (!isValidConnection(connection)) continue;
        if (
          nextEdges.some(
            (edge) =>
              edgeTouchesPin(
                edge,
                connection.source,
                connection.sourceHandle,
              ) ||
              edgeTouchesPin(
                edge,
                connection.target,
                connection.targetHandle,
              ) ||
              (replaceIncomingOnConnect && edge.target === connection.target) ||
              (uniqueDirectedPairOnConnect &&
                edge.source === connection.source &&
                edge.target === connection.target),
          )
        )
          continue;
        nextEdges = [
          ...nextEdges,
          {
            ...connection,
            id: createEdgeId(
              connection.source,
              connection.sourceHandle,
              connection.target,
              connection.targetHandle,
            ),
            ...(defaultEdgeOptions.type
              ? { type: defaultEdgeOptions.type }
              : {}),
          },
        ];
      }
      if (nextEdges === previousEdges) return;
      commitGraph(nextNodes, nextEdges);
    },
    [
      cancelProximityConnections,
      collectProximityConnections,
      commitGraph,
      defaultEdgeOptions.type,
      interactions.shakeEnabled,
      nodesDraggable,
      readOnly,
      isValidConnection,
      replaceIncomingOnConnect,
      uniqueDirectedPairOnConnect,
    ],
  );

  const onPinTap = useCallback(
    (nodeId: string, pinId: string, direction: "in" | "out") => {
      if (readOnly) {
        onPinSelect?.(nodeId, pinId);
        return;
      }
      const tapped = graphStateRef.current.nodes.find((node) => node.id === nodeId);
      if (tapped && isDisabledNode(tapped)) return;
      if (direction === "out") {
        const next = { nodeId, pinId };
        pendingPinRef.current = next;
        setPendingPin(next);
        return;
      }

      const activePin = pendingPinRef.current;
      if (!activePin) return;
      const sourcePin = pinOnNode(graphStateRef.current.nodes, activePin.nodeId, activePin.pinId);
      const targetPin = pinOnNode(graphStateRef.current.nodes, nodeId, pinId);
      if (activePin.nodeId === nodeId && (sourcePin?.kind !== "exec" || targetPin?.kind !== "exec")) {
        pendingPinRef.current = null;
        setPendingPin(null);
        return;
      }

      const incoming = {
        source: activePin.nodeId,
        target: nodeId,
        sourceHandle: activePin.pinId,
        targetHandle: pinId,
      };
      if (!isValidConnection(incoming)) return;

      addEdge(activePin.nodeId, activePin.pinId, nodeId, pinId);
      pendingPinRef.current = null;
      setPendingPin(null);
    },
    [addEdge, isValidConnection, onPinSelect, readOnly],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      // A cancelled drag ends without a wire, even when XYFlow later reports
      // the handle it last hovered.
      if (readOnly || connectDragRef.current?.connectEndHandled) return;
      const next = orientThenNormalize(
        connection,
        graphStateRef.current.nodes,
        normalizeConnection,
      );
      if (
        !next?.source ||
        !next.target ||
        !next.sourceHandle ||
        !next.targetHandle
      ) {
        return;
      }
      addEdge(
        next.source,
        next.sourceHandle,
        next.target,
        next.targetHandle,
      );
      if (connectDragRef.current) {
        connectDragRef.current.connectCommitted = true;
      }
      setPendingPin(null);
      pendingPinRef.current = null;
    },
    [addEdge, normalizeConnection, readOnly],
  );

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      if (readOnly) return;
      if (!params.nodeId || !params.handleId) return;
      const point = clientPoint(event);
      connectDragRef.current = {
        pointerId: connectEventPointerId(event),
        pointer: point ?? { x: 0, y: 0 },
        nodeId: params.nodeId,
        pinId: params.handleId,
        connectEndHandled: false,
        connectCommitted: false,
      };
    },
    [readOnly],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const connectEndHandled =
        connectDragRef.current?.connectEndHandled === true;
      const connectCommitted =
        connectDragRef.current?.connectCommitted === true;
      connectDragRef.current = null;
      const finishGesture = () => {
        storeApi.getState().cancelConnection();
        pendingPinRef.current = null;
        setPendingPin(null);
      };
      if (readOnly || connectEndHandled) {
        if (!connectEndHandled) finishGesture();
        return;
      }
      const fromHandle = state.fromHandle;
      const fromNode = state.fromNode;
      if (!fromHandle?.id || !fromNode) {
        finishGesture();
        return;
      }
      const pinId = fromHandle.id;
      const commitConnection = (
        source: string,
        sourceHandle: string,
        target: string,
        targetHandle: string,
      ) => {
        const incoming = {
          source,
          target,
          sourceHandle,
          targetHandle,
        };
        const next = orientThenNormalize(
          incoming,
          graphStateRef.current.nodes,
          normalizeConnection,
        );
        if (
          !next?.source ||
          !next.target ||
          !next.sourceHandle ||
          !next.targetHandle
        ) {
          return false;
        }
        if (!isValidConnection(next)) return false;
        addEdge(
          next.source,
          next.sourceHandle,
          next.target,
          next.targetHandle,
        );
        return true;
      };
      const toNodeId = state.toNode?.id ?? state.toHandle?.nodeId;
      if (state.toHandle?.id && toNodeId && !connectCommitted) {
        commitConnection(
          fromNode.id,
          pinId,
          toNodeId,
          state.toHandle.id,
        );
      }
      const point = clientPoint(event);
      if (!point) {
        finishGesture();
        return;
      }
      const pin = pinOnNode(
        graphStateRef.current.nodes,
        fromNode.id,
        pinId,
      );
      if (!pin) {
        finishGesture();
        return;
      }
      const root = wrapperRef.current ?? document;
      const located = screenPinsForSafeRefs(
        root,
        collectDisplayConnectPins(
          graphStateRef.current.nodes,
          fromNode.id,
          pin,
          displayTypeLookup(pinDisplayTypesRef.current),
          pinCompatibility,
        ),
      );
      const snap = nearestSnapConnectPin(point, {
        nodeId: fromNode.id,
        pinId,
      }, located);
      const decision = {
        hasTargetHandle: Boolean(state.toHandle),
        pointerOverNode: isClientPointOverGraphNode(point, root),
        pointerOverSourceHandle: isClientPointOverHandle(
          point,
          fromNode.id,
          pinId,
          root,
        ),
        pointer: point,
        safePins: located.map((entry) => ({ x: entry.x, y: entry.y })),
        snapPins: located
          .filter((entry) => entry.nodeId !== fromNode.id)
          .map((entry) => ({ x: entry.x, y: entry.y })),
      };
      const action = connectEndAction(decision, connectEndMode);
      if (action === "connect" && snap) {
        const sourceIsDragged = pin.direction === "out";
        commitConnection(
          sourceIsDragged ? fromNode.id : snap.nodeId,
          sourceIsDragged ? pinId : snap.pinId,
          sourceIsDragged ? snap.nodeId : fromNode.id,
          sourceIsDragged ? snap.pinId : pinId,
        );
        finishGesture();
        return;
      }
      if (action === "add-node") {
        const position = screenToFlowPosition(point);
        setPendingConnect({ pin, nodeId: fromNode.id, position });
        setPaletteAnchor(point);
        setPaletteModal(false);
        setPaletteOpenState(true);
        finishGesture();
        return;
      }
      if (action === "break") {
        setEdges((current) => {
          const next = current.filter(
            (edge) => !edgeTouchesPin(edge, fromNode.id, pinId),
          );
          if (next.length === current.length) return current;
          emitChange(graphStateRef.current.nodes, next);
          return next;
        });
      }
      finishGesture();
    },
    [
      addEdge,
      connectEndMode,
      emitChange,
      isValidConnection,
      normalizeConnection,
      pinCompatibility,
      readOnly,
      screenToFlowPosition,
      storeApi,
    ],
  );

  const handleAddPaletteNode = useCallback(
    (paletteNode: PaletteNode) => {
      // Toolbar additions have no chosen point: centre them on the canvas and
      // step by node footprint to a free slot.
      let position = pendingConnect?.position;
      if (!position) {
        const bounds = wrapperRef.current?.getBoundingClientRect();
        const center = screenToFlowPosition({
          x: (bounds?.left ?? 0) + (bounds?.width ?? 0) / 2,
          y: (bounds?.top ?? 0) + (bounds?.height ?? 0) / 2,
        });
        position = freeNodePosition(
          center,
          estimateGraphNodeSize(paletteNode.pins),
          graphStateRef.current.nodes,
        );
      }
      const id = uniqueNodeId(
        `${paletteNode.id}-${Date.now()}`,
        new Set(graphStateRef.current.nodes.map((node) => node.id)),
      );
      const data: Record<string, unknown> = {
        ...(paletteNode.defaultData ?? {}),
        title: paletteNode.title,
        __nodeType: paletteNode.nodeType ?? paletteNode.id,
        __category: paletteNode.category,
        __pure: paletteNode.pure ?? false,
        __latent: paletteNode.latent ?? false,
      };
      if (paletteNode.editorOnly === true) {
        data.__editorOnly = true;
      }
      if (paletteNode.pins && paletteNode.pins.length > 0) {
        data.__pins = paletteNode.pins;
      }
      const nextNode: CanvasNode = withDragHandle(
        {
          id,
          type: resolveNodeType(
            paletteNode.nodeType ?? paletteNode.id,
            data,
            knownTypes,
          ),
          position,
          selected: true,
          data,
        },
        nodeDragHandle,
      );

      const next = [
        ...graphStateRef.current.nodes.map((node) =>
          node.selected ? { ...node, selected: false } : node,
        ),
        nextNode,
      ];
      const connect = pendingConnect;
      let nextEdges = withoutEdgeSelection(graphStateRef.current.edges);
      let replacedWire = false;
      if (connect?.pin && connect.nodeId) {
        const dragged = overlayPin(
          connect.pin,
          connect.nodeId,
          pinDisplayTypesRef.current,
        );
        const match = firstCompatiblePin(
          paletteNode.pins,
          dragged,
          pinCompatibility,
        );
        if (match) {
          const sourceIsDragged = connect.pin.direction === "out";
          const source = sourceIsDragged ? connect.nodeId : id;
          const sourceHandle = sourceIsDragged ? connect.pin.id : match.id;
          const target = sourceIsDragged ? id : connect.nodeId;
          const targetHandle = sourceIsDragged ? match.id : connect.pin.id;
          const edgeId = createEdgeId(source, sourceHandle, target, targetHandle);
          replacedWire =
            singleExecOutputOnConnect &&
            replacesExecOutputWire(
              nextEdges,
              { source, sourceHandle, target, targetHandle },
              (nodeId, pinId) => pinOnNode(next, nodeId, pinId),
            );
          nextEdges = edgesAfterConnect(
            nextEdges,
            {
              id: edgeId,
              source,
              target,
              sourceHandle,
              targetHandle,
              ...(defaultEdgeOptions.type
                ? { type: defaultEdgeOptions.type }
                : {}),
            },
            (nodeId, pinId) => pinOnNode(next, nodeId, pinId),
            { replaceIncoming: replaceIncomingOnConnect, uniqueDirectedPair: uniqueDirectedPairOnConnect, singleExecOutput: singleExecOutputOnConnect },
          );
        }
      }
      commitGraph(next, nextEdges);
      if (replacedWire) noteReplacedWire();
      setPendingConnect(null);
    },
    [
      commitGraph,
      defaultEdgeOptions.type,
      knownTypes,
      nodeDragHandle,
      noteReplacedWire,
      pendingConnect,
      pinCompatibility,
      replaceIncomingOnConnect,
      uniqueDirectedPairOnConnect,
      singleExecOutputOnConnect,
      screenToFlowPosition,
    ],
  );

  const selectedNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes],
  );
  const selectedEdges = useMemo(
    () => edges.filter((edge) => edge.selected),
    [edges],
  );
  const selectionIsOnlyProtected =
    selectedNodes.length > 0 &&
    selectedNodes.every((node) => isProtectedNode(node));
  const hasBreakableLinks = useMemo(() => {
    if (selectedEdges.length > 0) return true;
    const selected = new Set(selectedNodes.map((node) => node.id));
    return edgesTouchingNodes(edges, selected).length > 0;
  }, [edges, selectedEdges, selectedNodes]);

  const onSelectionChangeRef = useRef(onSelectionChange);
  useLayoutEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  });
  const selectionKey = selectedNodes.map((node) => node.id).join("\0");
  useEffect(() => {
    onSelectionChangeRef.current?.(
      selectionKey === "" ? [] : selectionKey.split("\0"),
    );
  }, [selectionKey]);

  const onEdgeSelectionChangeRef = useRef(onEdgeSelectionChange);
  useLayoutEffect(() => {
    onEdgeSelectionChangeRef.current = onEdgeSelectionChange;
  });
  const edgeSelectionKey = selectedEdges.map((edge) => edge.id).join("\0");
  useEffect(() => {
    onEdgeSelectionChangeRef.current?.(
      edgeSelectionKey === "" ? [] : edgeSelectionKey.split("\0"),
    );
  }, [edgeSelectionKey]);

  // The selected, copyable nodes with the wires between them. Reads the graph
  // ref, so a menu built before the next render still sees its own selection.
  const clipFromSelection = useCallback((): GraphClip | null => {
    const { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
    const selected = currentNodes.filter(
      (node) => node.selected && !isProtectedNode(node),
    );
    if (selected.length === 0) return null;
    const ids = new Set(selected.map((node) => node.id));
    return {
      nodes: selected.map((node) => ({
        ...node,
        data: { ...node.data },
      })),
      edges: currentEdges.filter((edge) => {
        return ids.has(edge.source) && ids.has(edge.target);
      }),
    };
  }, []);

  const copySelection = useCallback((): boolean => {
    const clip = clipFromSelection();
    if (!clip) return false;
    clipboardRef.current = clip;
    setHasClipboard(true);
    return true;
  }, [clipFromSelection]);

  // One graph change, so one undo entry however many nodes arrive.
  const pasteClip = useCallback(
    (clip: GraphClip | null): boolean => {
      if (!clip) return false;
      const pasteable = clip.nodes.filter((node) => !isProtectedNode(node));
      if (pasteable.length === 0) return false;
      const current = graphStateRef.current.nodes;
      // Each paste lands one step past the copies already on the canvas.
      const offset = nonOverlappingOffset(
        pasteable.map((node) => node.position),
        current,
      );
      const taken = new Set(current.map((node) => node.id));
      const idMap = new Map<string, string>();
      const stamp = Date.now();
      const nextNodes = pasteable.map((node, index) => {
        const id = uniqueNodeId(`${node.id}-copy-${stamp}-${index}`, taken);
        taken.add(id);
        idMap.set(node.id, id);
        return withDragHandle(
          {
            ...node,
            id,
            selected: true,
            position: {
              x: node.position.x + offset,
              y: node.position.y + offset,
            },
            data: { ...node.data },
          },
          nodeDragHandle,
        );
      });
      const nextEdges = clip.edges.flatMap((edge) => {
        const source = idMap.get(edge.source);
        const target = idMap.get(edge.target);
        if (!source || !target) return [];
        const sourceHandle = edge.sourceHandle ?? "";
        const targetHandle = edge.targetHandle ?? "";
        return [
          {
            ...edge,
            id: createEdgeId(source, sourceHandle, target, targetHandle),
            source,
            target,
            selected: false,
          },
        ];
      });
      // The pasted nodes become the whole selection, wires included.
      const { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
      commitGraph(
        [
          ...currentNodes.map((node) =>
            node.selected ? { ...node, selected: false } : node,
          ),
          ...nextNodes,
        ],
        [...withoutEdgeSelection(currentEdges), ...nextEdges],
      );
      return true;
    },
    [commitGraph, nodeDragHandle],
  );

  const pasteClipboard = useCallback(
    (): boolean => pasteClip(clipboardRef.current),
    [pasteClip],
  );

  // Copy and paste in one step; the clipboard keeps what it held.
  const duplicateSelection = useCallback(
    (): boolean => pasteClip(clipFromSelection()),
    [clipFromSelection, pasteClip],
  );

  // Removes the nodes, their wires and the listed wires as one graph change.
  // Returns whether anything was removed.
  const removeGraphElements = useCallback(
    (nodeIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): boolean => {
      const { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
      const nextNodes = currentNodes.filter((node) => !nodeIds.has(node.id));
      const nextEdges = currentEdges.filter(
        (edge) =>
          !edgeIds.has(edge.id) &&
          !nodeIds.has(edge.source) &&
          !nodeIds.has(edge.target),
      );
      if (
        nextNodes.length === currentNodes.length &&
        nextEdges.length === currentEdges.length
      ) {
        return false;
      }
      commitGraph(nextNodes, nextEdges);
      return true;
    },
    [commitGraph],
  );

  const deleteSelection = useCallback(() => {
    const selected = new Set(
      deletableNodeIds(graphStateRef.current.nodes),
    );
    if (selected.size === 0) return;
    removeGraphElements(selected, new Set());
  }, [removeGraphElements]);

  // XYFlow `fitView` only sees mounted nodes; virtualisation unmounts the rest.
  const fitGraph = useCallback(() => {
    const bounds = graphNodesBounds(graphStateRef.current.nodes);
    const { width, height, minZoom } = storeApi.getState();
    if (!bounds || width <= 0 || height <= 0) return;
    const { maxZoom, padding } = graphViewport.fitViewOptions;
    void setViewport(
      getViewportForBounds(bounds, width, height, minZoom, maxZoom, padding),
    );
  }, [graphViewport.fitViewOptions, setViewport, storeApi]);

  // The effective chords: the editor's keybinds, except a host that passes
  // `deleteKeyCode` (null turns key deletion off) names its own delete keys.
  const commandBindings = useMemo((): GraphKeybinds => {
    if (deleteKeyCode === undefined) return keybinds;
    const keys = deleteKeyCode === null ? [] : [deleteKeyCode].flat();
    return {
      ...keybinds,
      delete: keys.flatMap((key) => normalizeChord(key) ?? []),
    };
  }, [deleteKeyCode, keybinds]);

  // A toolbar action a host hides has no key either; Duplicate needs both
  // halves. Returns whether the graph handled the command.
  const runGraphCommand = useCallback(
    (command: GraphCommand): boolean => {
      switch (command) {
        case "copy":
          return !hiddenToolbar.has("copy") && copySelection();
        case "paste":
          return !hiddenToolbar.has("paste") && pasteClipboard();
        case "duplicate":
          if (hiddenToolbar.has("copy") || hiddenToolbar.has("paste")) return false;
          // The graph owns this chord while it is engaged, even with nothing
          // selected: the browser's bookmark dialog is never wanted here.
          duplicateSelection();
          return true;
        case "delete": {
          const { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
          return removeGraphElements(
            new Set(deletableNodeIds(currentNodes)),
            new Set(currentEdges.filter((edge) => edge.selected).map((edge) => edge.id)),
          );
        }
      }
    },
    [copySelection, duplicateSelection, hiddenToolbar, pasteClipboard, removeGraphElements],
  );
  const commandRef = useRef({ readOnly, bindings: commandBindings, run: runGraphCommand });
  useLayoutEffect(() => {
    commandRef.current = { readOnly, bindings: commandBindings, run: runGraphCommand };
  });

  // React Flow's own delete key listens on the whole document, so hidden tabs
  // and other panels' keys deleted this graph's selection. Only the graph last
  // pressed or focused reacts to Copy, Paste, Duplicate and Delete; keys typed
  // into a text field, menu or foreign dialog keep their meaning, and protected
  // nodes stay. Deleting takes the selected nodes, their wires and the selected
  // wires in one graph change. The listener reads everything through refs, so
  // a host re-render never un-engages the graph.
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    let engaged = false;
    const inside = (target: EventTarget | null) => target instanceof Node && root.contains(target);
    const onPointerDown = (event: PointerEvent) => { engaged = inside(event.target); };
    const onFocusIn = (event: FocusEvent) => { if (inside(event.target)) engaged = true; };
    const onKeyDown = (event: KeyboardEvent) => {
      const { readOnly: locked, bindings, run } = commandRef.current;
      if (!engaged || locked || event.defaultPrevented || event.isComposing) return;
      const command = graphCommandForEvent(event, bindings);
      if (!command) return;
      if (event.target instanceof Element) {
        if (event.target.closest(KEY_EXEMPT_TARGETS)) return;
        const dialog = event.target.closest('[role="dialog"], [role="alertdialog"]');
        if (dialog && !dialog.contains(root)) return;
      }
      if (!root.isConnected || !(root.checkVisibility?.() ?? true)) return;
      if (run(command)) event.preventDefault();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const breakSelectionLinks = useCallback(() => {
    const selectedEdgeIds = new Set(
      graphStateRef.current.edges
        .filter((edge) => edge.selected)
        .map((edge) => edge.id),
    );
    if (selectedEdgeIds.size > 0) {
      setEdges((current) => {
        const next = current.filter((edge) => !selectedEdgeIds.has(edge.id));
        if (next.length === current.length) return current;
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
      return;
    }
    const selected = new Set(
      graphStateRef.current.nodes
        .filter((node) => node.selected)
        .map((node) => node.id),
    );
    if (selected.size === 0) return;
    setEdges((current) => {
      const touching = edgesTouchingNodes(current, selected);
      if (touching.length === 0) return current;
      const drop = new Set(touching.map((edge) => edge.id));
      const next = current.filter((edge) => !drop.has(edge.id));
      emitChange(graphStateRef.current.nodes, next);
      return next;
    });
  }, [emitChange]);

  const formatSelection = useCallback(() => {
    const selected = graphStateRef.current.nodes
      .filter((node) => node.selected)
      .map((node) => node.id);
    if (selected.length === 0) return;
    const { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
    const formatted = formatGraphNodes(
      currentNodes.map((node) => ({
        id: node.id,
        position: node.position,
        width: node.measured?.width ?? node.width,
        height: node.measured?.height ?? node.height,
        pins: hasSerializedPins(node.data) ? node.data.__pins : undefined,
      })),
      currentEdges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
      })),
      selected,
    );
    const positions = new Map(
      formatted.map((node) => [node.id, node.position]),
    );
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const position = positions.get(node.id);
        if (
          !position ||
          (position.x === node.position.x && position.y === node.position.y)
        ) {
          return node;
        }
        changed = true;
        return { ...node, position };
      });
      if (!changed) return current;
      emitChange(next, graphStateRef.current.edges);
      return next;
    });
  }, [emitChange]);

  // The menu of a script-style node. A press on an unselected node replaces the
  // selection first, like a tap; on a selected node the group stays. Everything
  // reads the graph ref, because the items are built before the next render.
  const resolveNodeMenu = useCallback(
    (nodeId: string): NestedMenuItem[] => {
      let { nodes: currentNodes, edges: currentEdges } = graphStateRef.current;
      const target = currentNodes.find((node) => node.id === nodeId);
      if (!target) return [];
      if (!target.selected) {
        currentNodes = currentNodes.map((node) =>
          Boolean(node.selected) === (node.id === nodeId)
            ? node
            : { ...node, selected: node.id === nodeId },
        );
        currentEdges = withoutEdgeSelection(currentEdges);
        graphStateRef.current = { nodes: currentNodes, edges: currentEdges };
        setNodes(currentNodes);
        setEdges(currentEdges);
      }
      const hostItems = contextMenuItemsForNode?.(nodeId) ?? [];
      if (readOnly) return hostItems;
      const selectedIds = new Set(
        currentNodes.filter((node) => node.selected).map((node) => node.id),
      );
      const editable = currentNodes.some(
        (node) => node.selected && !isProtectedNode(node),
      );
      const canPaste = (clipboardRef.current?.nodes ?? []).some(
        (node) => !isProtectedNode(node),
      );
      const hasLinks =
        currentEdges.some((edge) => edge.selected) ||
        edgesTouchingNodes(currentEdges, selectedIds).length > 0;
      const items: NestedMenuItem[] = [];
      if (!hiddenToolbar.has("copy")) {
        items.push({
          id: "copy",
          label: "Copy",
          shortcut: commandBindings.copy[0],
          disabled: !editable,
          onSelect: () => { copySelection(); },
        });
      }
      if (!hiddenToolbar.has("paste")) {
        items.push({
          id: "paste",
          label: "Paste",
          shortcut: commandBindings.paste[0],
          disabled: !canPaste,
          onSelect: () => { pasteClipboard(); },
        });
      }
      if (!hiddenToolbar.has("copy") && !hiddenToolbar.has("paste")) {
        items.push({
          id: "duplicate",
          label: "Duplicate",
          shortcut: commandBindings.duplicate[0],
          disabled: !editable,
          onSelect: () => { duplicateSelection(); },
        });
      }
      if (!hiddenToolbar.has("delete")) {
        items.push({
          id: "delete",
          label: "Delete",
          shortcut: commandBindings.delete[0],
          variant: "destructive",
          disabled: !editable,
          onSelect: deleteSelection,
        });
      }
      if (!hiddenToolbar.has("breakLinks")) {
        if (items.length > 0) items.push({ type: "separator", id: "break-links-separator" });
        items.push({
          id: "break-links",
          label: "Break Links",
          disabled: !hasLinks,
          onSelect: breakSelectionLinks,
        });
      }
      return hostItems.length > 0 && items.length > 0
        ? [...hostItems, { type: "separator", id: "host-separator" }, ...items]
        : [...hostItems, ...items];
    },
    [
      breakSelectionLinks,
      commandBindings,
      contextMenuItemsForNode,
      copySelection,
      deleteSelection,
      duplicateSelection,
      hiddenToolbar,
      pasteClipboard,
      readOnly,
    ],
  );
  const nodeMenu = useMemo(
    () => ({
      enabled: !readOnly || Boolean(contextMenuItemsForNode),
      resolve: resolveNodeMenu,
    }),
    [contextMenuItemsForNode, readOnly, resolveNodeMenu],
  );

  const clearSelection = useCallback(() => {
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: false })),
    );
    setEdges(withoutEdgeSelection);
  }, []);

  const handlePaneClick = useCallback(
    (event?: { clientX: number; clientY: number }) => {
      if (skipPaneClickRef.current) {
        skipPaneClickRef.current = false;
        return;
      }
      const pending = pendingPinRef.current;
      if (!readOnly && connectEndMode === "add-node" && pending) {
        pendingPinRef.current = null;
        setPendingPin(null);
        return;
      }
      clearSelection();
      const now = Date.now();
      if (now - lastPaneTapRef.current < DOUBLE_TAP_MS && !readOnly) {
        const point = event ? { x: event.clientX, y: event.clientY } : null;
        setPendingConnect(point ? { position: screenToFlowPosition(point) } : null);
        setPaletteAnchor(point);
        setPaletteModal(false);
        setPaletteOpenState(true);
      }
      lastPaneTapRef.current = now;
    },
    [
      clearSelection,
      connectEndMode,
      readOnly,
      screenToFlowPosition,
    ],
  );

  const handlePaneContextMenu = useCallback(
    (event: {
      preventDefault: () => void;
      clientX: number;
      clientY: number;
      target?: EventTarget | null;
    }) => {
      event.preventDefault();
      if (readOnly) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".react-flow__node")
      ) {
        return;
      }
      const selected = graphStateRef.current.nodes.find((node) => node.selected);
      if (selected && contextMenuItemsForNode) {
        const items = contextMenuItemsForNode(selected.id);
        if (items.length > 0) {
          paneMenu.openMenuAt(event.clientX, event.clientY, items);
          return;
        }
      }
      if (paletteNodes && paletteNodes.length > 0) {
        const point = { x: event.clientX, y: event.clientY };
        setPendingConnect({ position: screenToFlowPosition(point) });
        setPaletteAnchor(point);
        setPaletteModal(false);
        setPaletteOpenState(true);
      }
    },
    [
      contextMenuItemsForNode,
      paletteNodes,
      paneMenu.openMenuAt,
      readOnly,
      screenToFlowPosition,
    ],
  );

  const screenToFlowPositionRef = useRef(screenToFlowPosition);
  const pinCompatibilityRef = useRef(pinCompatibility);
  const readOnlyRef = useRef(readOnly);
  const connectEndModeRef = useRef(connectEndMode);
  useLayoutEffect(() => {
    screenToFlowPositionRef.current = screenToFlowPosition;
    pinCompatibilityRef.current = pinCompatibility;
    readOnlyRef.current = readOnly;
    connectEndModeRef.current = connectEndMode;
  });

  useEffect(() => {
    if (!onCanvasApi) return;
    onCanvasApi(
      createGraphCanvasDropApi(wrapperRef.current, (point) =>
        screenToFlowPositionRef.current(point),
      ),
    );
    return () => onCanvasApi(null);
  }, [onCanvasApi]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handle = attachGraphPaneMarquee(wrapper, {
      onArmedChange: setMarqueeArmed,
      onMarqueeRect: setMarqueeScreen,
      onMarqueeEnd: (startClient, endClient) => {
        skipPaneClickRef.current = true;
        const from = screenToFlowPositionRef.current(startClient);
        const to = screenToFlowPositionRef.current(endClient);
        const ids = new Set(
          nodesIntersectingMarquee(
            graphStateRef.current.nodes,
            flowRectFromPoints(from, to),
          ),
        );
        setNodes((current) =>
          current.map((node) => ({
            ...node,
            selected: ids.has(node.id),
          })),
        );
        setEdges(withoutEdgeSelection);
      },
    });
    return () => handle.dispose();
  }, []);

  useEffect(() => {
    // The gesture ends with no action: a later release only lets XYFlow tidy
    // up, and the next move ends its drag because the connection is gone.
    const endConnectSession = (
      session: NonNullable<typeof connectDragRef.current>,
    ) => {
      session.connectEndHandled = true;
      pendingPinRef.current = null;
      setPendingPin(null);
      storeApi.getState().cancelConnection();
    };

    const onMove = (event: Event) => {
      const session = connectDragRef.current;
      if (!session) return;
      if (
        connectEventPointerId(event as MouseEvent | TouchEvent) !==
        session.pointerId
      ) {
        return;
      }
      const point = clientPoint(event as MouseEvent | TouchEvent);
      if (point) session.pointer = point;
    };

    // XYFlow drags pins with touch events and never sees `touchcancel`.
    const onTouchCancel = (event: Event) => {
      const session = connectDragRef.current;
      if (!session || session.connectEndHandled) return;
      const touches = (event as TouchEvent).changedTouches;
      if (
        !touches ||
        !Array.from(touches).some(
          (touch) => touch.identifier === session.pointerId,
        )
      ) {
        return;
      }
      endConnectSession(session);
    };

    const onSecondaryPointerDown = (event: Event) => {
      const session = connectDragRef.current;
      if (!session || session.connectEndHandled || readOnlyRef.current) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".react-flow")) {
        return;
      }
      const eventPointerId = connectEventPointerId(
        event as MouseEvent | TouchEvent,
      );
      if (eventPointerId === session.pointerId) return;
      event.preventDefault();
      const cancelRubberBand = () => {
        skipPaneClickRef.current = true;
        endConnectSession(session);
      };
      if (
        shouldCancelConnectionOnSecondaryPointer({
          connectionActive: true,
          dragPointerId: session.pointerId,
          eventPointerId,
          mode: connectEndModeRef.current,
        })
      ) {
        cancelRubberBand();
        return;
      }
      const pin = pinOnNode(
        graphStateRef.current.nodes,
        session.nodeId,
        session.pinId,
      );
      if (!pin) return;
      const connection = storeApi.getState().connection;
      const pointer = connectDragClientPoint(session, {
        inProgress: connection.inProgress,
        pointer: connection.inProgress ? connection.pointer : null,
      }, wrapperRef.current ?? document);
      const inAddNodeZone = shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: Boolean(
          connection.inProgress && connection.toHandle,
        ),
        pointerOverNode: isClientPointOverGraphNode(pointer, wrapperRef.current ?? document),
        pointer,
        safePins: screenCentersForSafePins(
          wrapperRef.current ?? document,
          collectDisplayConnectPins(
            graphStateRef.current.nodes,
            session.nodeId,
            pin,
            displayTypeLookup(pinDisplayTypesRef.current),
            pinCompatibilityRef.current,
          ),
        ),
      });
      if (
        !shouldCancelConnectOnSecondaryPointer({
          connectionActive: true,
          dragPointerId: session.pointerId,
          eventPointerId,
          inAddNodeZone,
        })
      ) {
        return;
      }
      cancelRubberBand();
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("touchmove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerdown", onSecondaryPointerDown, true);
    document.addEventListener("touchstart", onSecondaryPointerDown, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchcancel", onTouchCancel, true);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("pointerdown", onSecondaryPointerDown, true);
      document.removeEventListener("touchstart", onSecondaryPointerDown, true);
      document.removeEventListener("touchcancel", onTouchCancel, true);
    };
  }, [storeApi]);

  const pinDisplayType = useCallback(
    (nodeId: string, pinId: string) =>
      pinDisplayTypes.get(pinTypeKey(nodeId, pinId)),
    [pinDisplayTypes],
  );

  const styledEdges = useMemo(
    () => styleFlowEdges(edges, pinNodes, pinDisplayTypes),
    [edges, pinNodes, pinDisplayTypes],
  );
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setHostSize((prev) => {
        if (width <= 0 || height <= 0) return prev;
        if (prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const keepIds = useMemo(() => {
    const ids = new Set<string>();
    if (focusedNodeId) ids.add(focusedNodeId);
    if (selectedNodeId) ids.add(selectedNodeId);
    for (const node of nodes) {
      if (node.selected) ids.add(node.id);
    }
    return [...ids];
  }, [focusedNodeId, nodes, selectedNodeId]);
  // The mounted nodes and edges follow the pan/zoom transform, but the editor renders
  // again only when that set changes, not on every pan or zoom frame.
  const visibleInputs = useRef<VisibleGraphInputs | null>(null);
  const visibleGraph = useStore((state) => {
    const [x, y, zoom] = state.transform;
    const last = visibleInputs.current;
    if (
      last &&
      last.nodes === nodes &&
      last.edges === styledEdges &&
      last.keepIds === keepIds &&
      last.width === hostSize.width &&
      last.height === hostSize.height &&
      last.x === x &&
      last.y === y &&
      last.zoom === zoom
    ) {
      return last.result;
    }
    const result = selectVisibleGraphElements(
      nodes,
      styledEdges,
      { x, y, zoom, width: hostSize.width, height: hostSize.height },
      GRAPH_VIRTUALIZE_OVERSCAN_PX,
      keepIds,
    );
    visibleInputs.current = {
      nodes,
      edges: styledEdges,
      keepIds,
      width: hostSize.width,
      height: hostSize.height,
      x,
      y,
      zoom,
      result,
    };
    return result;
  }, sameVisibleGraph);
  const virtualize = hostSize.width > 0 && hostSize.height > 0;

  const paletteSourcePins = useMemo(() => {
    if (!pendingConnect?.pin) return undefined;
    const nodeId = pendingConnect.nodeId;
    if (!nodeId) return [pendingConnect.pin];
    const node = nodes.find((entry) => entry.id === nodeId);
    const pins = hasSerializedPins(node?.data) ? node.data.__pins : undefined;
    if (!pins?.length) {
      return [overlayPin(pendingConnect.pin, nodeId, pinDisplayTypes)];
    }
    return pins.map((pin) => overlayPin(pin, nodeId, pinDisplayTypes));
  }, [nodes, pendingConnect, pinDisplayTypes]);

  const connectionLineStyle = useMemo(() => {
    if (pendingPin) {
      const source = nodes.find((node) => node.id === pendingPin.nodeId);
      const pins = hasSerializedPins(source?.data) ? source.data.__pins : [];
      const pin = pins.find((entry) => entry.id === pendingPin.pinId);
      const display =
        pinDisplayTypes.get(pinTypeKey(pendingPin.nodeId, pendingPin.pinId)) ??
        pin?.type;
      return edgeStyleForPin(display);
    }
    if (pendingConnect?.pin) {
      const display =
        (pendingConnect.nodeId
          ? pinDisplayTypes.get(
              pinTypeKey(pendingConnect.nodeId, pendingConnect.pin.id),
            )
          : undefined) ?? pendingConnect.pin.type;
      return edgeStyleForPin(display);
    }
    return edgeStyleForPin({ kind: "exec" });
  }, [nodes, pendingConnect, pendingPin, pinDisplayTypes]);

  const onPinDefaultChange = useCallback((nodeId: string, pinId: string, value: unknown) => {
    if (pinDefaultsDisabledRef.current) return;
    const current = graphStateRef.current;
    const node = current.nodes.find((entry) => entry.id === nodeId);
    if (!node || isDisabledNode(node) || !hasSerializedPins(node.data)) return;
    const pin = node.data.__pins.find((entry) => entry.id === pinId);
    if (!pin || pin.direction !== "in" || pin.kind !== "data" || pin.reference === "required") return;
    if (current.edges.some((edge) => edge.target === nodeId && edge.targetHandle === pinId)) return;
    const type = pinDisplayTypesRef.current.get(pinTypeKey(nodeId, pinId)) ?? pin.type;
    const normalized = inlinePinDefaultStorageValue({ ...pin, type }, node.data, value);
    if (normalized === undefined) return;
    const next = current.nodes.map((entry) => entry.id === nodeId
      ? { ...entry, data: { ...entry.data, [pinDefaultPropertyKey(pinId)]: normalized } } : entry);
    graphStateRef.current = { ...current, nodes: next };
    setNodes(next);
    emitChange(next, current.edges);
  }, [emitChange]);

  const contextValue = useMemo(
    () => ({
      pendingPin,
      onPinTap,
      onPinDefaultChange: pinDefaultsDisabled ? undefined : onPinDefaultChange,
      renderPinDefaultEditor,
      connectedInputs,
      nodeErrorCount,
      pinHasError,
      pinDisplayType,
      pinTypeNames,
      connectEndMode,
      pinCompatibility,
      onNavigateRequest,
      selectedAttachmentId,
      onAttachmentSelect,
      onAttachmentDoubleClick,
      contextMenuItemsForNode,
      contextMenuItemsForAttachment,
      onEdgeDoubleClick,
      renderNodeBody,
      nodeMenu,
      connectionRefusal,
      connectionLineKind:
        defaultEdgeOptions.type === "animTransition" ||
        defaultEdgeOptions.type === "animTransitionBoth"
          ? ("animTransition" as const)
          : ("default" as const),
    }),
    [
      nodeErrorCount,
      onNavigateRequest,
      onPinTap,
      onPinDefaultChange,
      pinDefaultsDisabled,
      renderPinDefaultEditor,
      connectedInputs,
      pendingPin,
      pinDisplayType,
      pinTypeNames,
      pinHasError,
      connectEndMode,
      pinCompatibility,
      selectedAttachmentId,
      onAttachmentSelect,
      onAttachmentDoubleClick,
      contextMenuItemsForNode,
      contextMenuItemsForAttachment,
      onEdgeDoubleClick,
      renderNodeBody,
      nodeMenu,
      connectionRefusal,
      defaultEdgeOptions.type,
    ],
  );

  return (
    <GraphEditorProvider value={contextValue}>
      <div
        ref={wrapperRef}
        className="relative h-full w-full touch-manipulation"
        data-testid="graph-editor"
        data-connect-end-mode={connectEndMode}
        data-focused-node-id={focusedNodeId || undefined}
        data-restore-viewport={sessionViewport ? "true" : undefined}
        data-virtualize={virtualize ? "true" : "false"}
        data-visible-node-count={String(visibleGraph.nodes.length)}
        data-readonly={readOnly ? "true" : undefined}
        data-nodes-draggable={nodesDraggable ? "true" : "false"}
      >
        {readOnly ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div
            className="pointer-events-auto toolbar-island flex-wrap"
            data-graph-overlay=""
            data-testid="graph-toolbar"
          >
            {paletteNodes && paletteNodes.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingConnect(null);
                setPaletteAnchor(null);
                setPaletteModal(true);
                setPaletteOpenState(true);
              }}
              data-testid="graph-add-node"
            >
              <PlusIcon data-icon="inline-start" />
              Add Node
            </Button>
            ) : null}
            {hiddenToolbar.has("copy") && hiddenToolbar.has("paste") ? null : <Separator orientation="vertical" />}
            {hiddenToolbar.has("copy") ? null : (
            <IslandIconButton
              label="Copy"
              disabled={selectedNodes.length === 0 || selectionIsOnlyProtected}
              onClick={copySelection}
              data-testid="graph-copy"
            >
              <CopyIcon />
            </IslandIconButton>
            )}
            {hiddenToolbar.has("paste") ? null : (
            <IslandIconButton
              label="Paste"
              disabled={!hasClipboard}
              onClick={pasteClipboard}
              data-testid="graph-paste"
            >
              <ClipboardPasteIcon />
            </IslandIconButton>
            )}
            {hiddenToolbar.has("delete") && hiddenToolbar.has("breakLinks") ? null : <Separator orientation="vertical" />}
            {hiddenToolbar.has("delete") ? null : (
            <IslandIconButton
              label="Delete"
              disabled={selectedNodes.length === 0 || selectionIsOnlyProtected}
              onClick={deleteSelection}
              data-testid="graph-delete"
            >
              <Trash2Icon />
            </IslandIconButton>
            )}
            {hiddenToolbar.has("breakLinks") ? null : (
            <IslandIconButton
              label="Break Links"
              hint="Break Links On The Selected Nodes Or Blend Rule"
              disabled={!hasBreakableLinks}
              onClick={breakSelectionLinks}
              data-testid="graph-break-links"
            >
              <UnlinkIcon />
            </IslandIconButton>
            )}
            {hiddenToolbar.has("format") ? null : (
            <>
            <Separator orientation="vertical" />
            <IslandIconButton
              label="Format"
              hint="Format Selection: Exec Runs Left To Right, Data Hangs Below"
              disabled={selectedNodes.length === 0}
              onClick={formatSelection}
              data-testid="graph-format"
            >
              <WaypointsIcon />
            </IslandIconButton>
            </>
            )}
            {toolbarExtra}
          </div>
        </div>
        )}
        <ReactFlow
          className="graph-editor-canvas isolate z-0"
          colorMode={colorMode}
          nodes={virtualize ? visibleGraph.nodes : nodes}
          edges={virtualize ? visibleGraph.edges : styledEdges}
          nodeTypes={knownTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={nodesDraggable}
          nodesConnectable={!readOnly}
          elementsSelectable
          edgesReconnectable={false}
          onlyRenderVisibleElements={false}
          onNodesChange={handleNodesChange}
          onNodeDragStart={(_event, node) => { proximityDragRef.current = !readOnly && nodesDraggable; shakenRef.current = false; const zoom = storeApi.getState().transform[2]; shakeTracker.current.reset(node.position.x * zoom, node.position.y * zoom, performance.now()); }}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
          onEdgeDoubleClick={(_, edge) => onEdgeDoubleClick?.(edge.id)}
          isValidConnection={readOnly ? () => false : isValidConnection}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          panOnDrag={!marqueeArmed}
          connectionLineStyle={connectionLineStyle}
          connectionLineComponent={GraphConnectionLine}
          defaultEdgeOptions={defaultEdgeOptions}
          connectionMode={
            connectionMode === "loose"
              ? ConnectionMode.Loose
              : connectionMode === "strict"
                ? ConnectionMode.Strict
                : undefined
          }
          deleteKeyCode={null}
          nodesFocusable={nodesFocusable}
          edgesFocusable={nodesFocusable}
          fitView={mountViewport.fitView}
          fitViewOptions={graphViewport.fitViewOptions}
          defaultViewport={mountViewport.defaultViewport}
          onMoveEnd={
            onSessionViewportChange
              ? (_event, viewport) => onSessionViewportChange(viewport)
              : undefined
          }
          minZoom={graphViewport.minZoom}
          maxZoom={graphViewport.maxZoom}
          zoomOnDoubleClick={graphViewport.zoomOnDoubleClick}
          proOptions={{ hideAttribution: true }}
        >
          <ViewportPortal>
            <svg aria-hidden="true" width="1" height="1" style={{ position: "absolute", overflow: "visible", pointerEvents: "none" }}>
              {proximityPaths.map(({ connection, path }) => (
                <path
                  key={createEdgeId(connection.source, connection.sourceHandle, connection.target, connection.targetHandle)}
                  className="graph-proximity-preview"
                  d={path}
                  fill="none"
                  style={{ stroke: "var(--muted-foreground)", strokeWidth: 2, opacity: 0.5, pointerEvents: "none" }}
                />
              ))}
            </svg>
          </ViewportPortal>
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--border)"
            bgColor="var(--graph-canvas)"
          />
          <SelectedNodeSync selectedNodeId={selectedNodeId} />
          <FocusedNodeSync
            focusedNodeId={focusedNodeId}
            fitViewOptions={graphViewport.focusedFitViewOptions}
          />
        </ReactFlow>
        <GraphViewportControls onFitGraph={fitGraph} />
        {wireNotice === 0 ? null : (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex justify-center">
            <Alert
              role="status"
              className="w-auto max-w-sm shadow-md"
              data-testid="graph-wire-notice"
            >
              <AlertDescription>{REPLACED_WIRE_NOTICE}</AlertDescription>
            </Alert>
          </div>
        )}
        {marqueeScreen ? (
          <div
            data-testid="graph-marquee"
            className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
          >
            <div
              className="absolute border-2 border-dashed border-primary bg-primary/25"
              style={{
                left: `${marqueeScreen.x}px`,
                top: `${marqueeScreen.y}px`,
                width: `${marqueeScreen.width}px`,
                height: `${marqueeScreen.height}px`,
              }}
            />
          </div>
        ) : null}
        {readOnly ? null : (
        <NodePalette
          open={paletteOpen}
          onOpenChange={(next) => {
            setPaletteOpenState(next);
            if (!next) setPendingConnect(null);
          }}
          paletteNodes={paletteNodes}
          filterPin={
            pendingConnect?.pin
              ? pendingConnect.nodeId
                ? overlayPin(
                    pendingConnect.pin,
                    pendingConnect.nodeId,
                    pinDisplayTypes,
                  )
                : pendingConnect.pin
              : null
          }
          pinCompatibility={pinCompatibility}
          sourcePins={paletteSourcePins}
          onAddNode={handleAddPaletteNode}
          anchor={paletteAnchor}
          presentation={paletteModal ? "modal" : "popup"}
        />
        )}
        <ContextMenuOverlay menu={paneMenu.menu} onClose={paneMenu.closeMenu} />
      </div>
    </GraphEditorProvider>
  );
}

export function GraphEditor(props: GraphEditorProps) {
  return (
    <AssetOpenProvider value={null}>
      <ReactFlowProvider>
        <GraphEditorCanvas {...props} />
      </ReactFlowProvider>
    </AssetOpenProvider>
  );
}
