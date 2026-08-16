import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  type Connection,
  type DefaultEdgeOptions,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeChange,
  type NodeTypes,
  type OnConnectStartParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph-editor.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@babylonslate/ui/components/button";
import {
  ContextMenuOverlay,
  useContextMenu,
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
import { GraphEditorProvider } from "./graph-editor-context";
import {
  canonicalGraphSignature,
  createEdgeId,
  deletableNodeIds,
  graphChangeKindFromNodeChanges,
  isProtectedNode,
  lockNodeDragAxis,
  allocateGraphDragTransaction,
  nodeChangesMutateGraph,
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
import { edgeStyleForPin } from "./node-theme";
import { NodePalette } from "./node-palette";
import { GraphConnectionLine } from "./connection-line";
import {
  collectSafeConnectPins,
  connectEndAction,
  connectEventPointerId,
  containerPointerToClient,
  edgesAfterConnect,
  edgesTouchingNodes,
  edgeTouchesPin,
  firstCompatiblePin,
  isClientPointOverGraphNode,
  isClientPointOverHandle,
  nodePinLists,
  pinsAreCompatible,
  screenCentersForSafePins,
  type ConnectEndMode,
  type PinCompatibilityRule,
  shouldOpenAddNodeOnConnectEnd,
  shouldOpenAddNodeOnSecondaryPointer,
} from "./graph-connect";
import { displayPinTypesForGraph, pinTypeKey } from "./wildcard-display";
import type { PinDisplayLookup } from "./wildcard-display";
import {
  GRAPH_DEFAULT_ZOOM,
  resolveGraphViewport,
  type GraphViewport,
} from "./graph-viewport";
import { formatGraphNodes } from "./graph-format";
import {
  attachGraphPaneMarquee,
  flowRectFromPoints,
  nodesIntersectingMarquee,
} from "./graph-marquee";
import {
  createGraphCanvasDropApi,
  type GraphCanvasDropApi,
} from "./graph-canvas-api";

export type { GraphDocument, GraphDiagnostic, NavigateRequest, PaletteNode };
export type { SerializedPin } from "./graph-types";
export {
  GRAPH_DEFAULT_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_MIN_ZOOM,
} from "./graph-viewport";

export interface GraphEditorProps {
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
  colorMode?: "light" | "dark";
  defaultZoom?: number;
  /** Pan/zoom only: no connect, node drag, palette, or Cut/Paste/Delete/Format. */
  readOnly?: boolean;
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
   * Connect-end policy. Default keeps the 96px cancel zone and wire-break
   * fallback. Behaviour trees use `add-node` so a short drag off a handle
   * opens Add Node and never breaks structural edges.
   */
  connectEndMode?: ConnectEndMode;
  /** Double-tap empty pane opens Add Node. Default true. */
  emptyPaneDoubleTapAddsNode?: boolean;
  /** Replace existing edges into the same target handle (tree parent pin). */
  replaceIncomingOnConnect?: boolean;
  /** Extra host connection veto after pin compatibility. */
  canConnect?: (connection: {
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
  }) => boolean;
  contextMenuItemsForNode?: (nodeId: string) => NestedMenuItem[];
  contextMenuItemsForAttachment?: (
    nodeId: string,
    attachmentId: string,
  ) => NestedMenuItem[];
  onAttachmentDoubleClick?: (nodeId: string, attachmentId: string) => void;
  /** Host connection rule (material Float splat). Defaults to exact kinds. */
  pinCompatibility?: PinCompatibilityRule;
  /** Registers client hit-test / flow conversion for Class-member drops. */
  onCanvasApi?: (api: GraphCanvasDropApi | null) => void;
}

const DOUBLE_TAP_MS = 350;
const PASTE_OFFSET = 40;

function toFlowEdges(edges: GraphDocument["edges"]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    ...(edge.type ? { type: edge.type } : {}),
  }));
}

function styleFlowEdges(
  edges: Edge[],
  nodes: CanvasNode[],
  displayTypes: PinDisplayLookup,
): Edge[] {
  return edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const pins = hasSerializedPins(source?.data) ? source.data.__pins : [];
    const pin = pins.find((entry) => entry.id === edge.sourceHandle);
    const display =
      (edge.sourceHandle
        ? displayTypes.get(pinTypeKey(edge.source, edge.sourceHandle))
        : undefined) ?? pin?.type;
    return {
      ...edge,
      style: edgeStyleForPin(display),
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

function pinOnNode(
  nodes: CanvasNode[],
  nodeId: string,
  pinId: string,
): SerializedPin | undefined {
  const node = nodes.find((entry) => entry.id === nodeId);
  const pins = hasSerializedPins(node?.data) ? node.data.__pins : [];
  return pins.find((pin) => pin.id === pinId);
}

function connectDragClientPoint(
  session: { pointer: { x: number; y: number } },
  connection: {
    inProgress: boolean;
    pointer?: { x: number; y: number } | null;
  },
): { x: number; y: number } {
  if (connection.inProgress && connection.pointer) {
    const flow = document.querySelector(".react-flow");
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

function FocusedNodeSync({
  focusedNodeId,
  fitViewOptions,
}: {
  focusedNodeId?: string;
  fitViewOptions: GraphViewport["focusedFitViewOptions"];
}) {
  const { fitView, getNode, setNodes } = useReactFlow();

  useEffect(() => {
    if (!focusedNodeId) return;
    const node = getNode(focusedNodeId);
    if (!node) return;

    setNodes((current) =>
      current.map((entry) => ({
        ...entry,
        selected: entry.id === focusedNodeId,
      })),
    );

    void fitView({
      nodes: [{ id: focusedNodeId }],
      ...fitViewOptions,
    });
  }, [fitView, fitViewOptions, focusedNodeId, getNode, setNodes]);

  return null;
}

function GraphEditorCanvas({
  initialGraph,
  onChange,
  commitPositionsOnDragEnd = false,
  onSelectionChange,
  focusedNodeId,
  diagnostics,
  onNavigateRequest,
  onNodeDoubleClick,
  onEdgeDoubleClick,
  onEdgeSelectionChange,
  paletteNodes,
  colorMode = "dark",
  defaultZoom = GRAPH_DEFAULT_ZOOM,
  readOnly = false,
  onPinSelect,
  nodeTypes: nodeTypesProp,
  edgeTypes,
  defaultEdgeOptions = { type: "default" },
  nodesDraggable: nodesDraggableProp,
  toolbarExtra,
  selectedAttachmentId = null,
  onAttachmentSelect,
  hiddenToolbarActions = [],
  lockNodeDragAxis: lockDragAxis,
  nodeDragHandle,
  connectEndMode = "default",
  emptyPaneDoubleTapAddsNode = true,
  replaceIncomingOnConnect = false,
  canConnect,
  contextMenuItemsForNode,
  contextMenuItemsForAttachment,
  onAttachmentDoubleClick,
  pinCompatibility,
  onCanvasApi,
}: GraphEditorProps) {
  const knownTypes = useMemo(
    () => ({ ...graphNodeTypes, ...nodeTypesProp }),
    [nodeTypesProp],
  );
  const nodesDraggable = nodesDraggableProp ?? !readOnly;
  const graphViewport = useMemo(
    () => resolveGraphViewport(defaultZoom),
    [defaultZoom],
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    toCanvasNodes(initialGraph.nodes, knownTypes, nodeDragHandle),
  );
  const [edges, setEdges] = useState<Edge[]>(() =>
    toFlowEdges(initialGraph.edges),
  );
  const [pendingPin, setPendingPin] = useState<{
    nodeId: string;
    pinId: string;
  } | null>(null);
  const pendingPinRef = useRef(pendingPin);
  pendingPinRef.current = pendingPin;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState<{
    pin?: SerializedPin;
    nodeId?: string;
    position: { x: number; y: number };
  } | null>(null);
  const connectDragRef = useRef<{
    pointerId: number;
    pointer: { x: number; y: number };
    nodeId: string;
    pinId: string;
    openedAddNode: boolean;
  } | null>(null);
  const suppressPaletteDismissRef = useRef(false);
  const paletteDismissHoldIdsRef = useRef<Set<number>>(new Set());
  const [marqueeScreen, setMarqueeScreen] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [marqueeArmed, setMarqueeArmed] = useState(false);
  const [hasClipboard, setHasClipboard] = useState(false);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; edges: Edge[] } | null>(
    null,
  );
  const lastPaneTapRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const skipPaneClickRef = useRef(false);
  const membersRef = useRef(initialGraph.members);
  membersRef.current = initialGraph.members;
  const componentsRef = useRef(initialGraph.components);
  componentsRef.current = initialGraph.components;
  const { screenToFlowPosition } = useReactFlow();
  const storeApi = useStoreApi();
  const graphStateRef = useRef({ nodes, edges });
  graphStateRef.current = { nodes, edges };
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

  const nodeErrorCount = useCallback(
    (nodeId: string) =>
      errorDiagnostics.filter((entry) => entry.nodeId === nodeId).length,
    [errorDiagnostics],
  );

  const pinHasError = useCallback(
    (nodeId: string, pinId: string) =>
      errorDiagnostics.some(
        (entry) => entry.nodeId === nodeId && entry.pinId === pinId,
      ),
    [errorDiagnostics],
  );

  const lastEmittedRef = useRef<GraphDocument | null>(null);
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
      if (
        lastEmittedRef.current &&
        canonicalGraphSignature(graph) ===
          canonicalGraphSignature(lastEmittedRef.current)
      ) {
        return;
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
          typeof data.__nodeType === "string"
            ? data.__nodeType
            : (node.type ?? "logMessage");
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

  useEffect(() => {
    setNodes((current) => {
      const next = current.map((node) => withDragHandle(node, nodeDragHandle));
      return next.every((node, index) => node === current[index])
        ? current
        : next;
    });
  }, [nodeDragHandle]);

  const hiddenToolbar = useMemo(
    () => new Set(hiddenToolbarActions),
    [hiddenToolbarActions],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => {
        const constrained = lockNodeDragAxis(changes, current, lockDragAxis);
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
      if (readOnly) return;
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        if (nodeChangesMutateGraph(changes)) {
          emitChange(graphStateRef.current.nodes, next);
        }
        return next;
      });
    },
    [emitChange, readOnly],
  );

  const addEdge = useCallback(
    (
      source: string,
      sourceHandle: string,
      target: string,
      targetHandle: string,
    ) => {
      const id = createEdgeId(source, sourceHandle, target, targetHandle);
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
          { replaceIncoming: replaceIncomingOnConnect },
        );
        const unchanged =
          next.length === current.length &&
          next.every((edge, index) => edge.id === current[index]?.id);
        if (unchanged) return current;
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
    },
    [defaultEdgeOptions.type, emitChange, replaceIncomingOnConnect],
  );

  const onPinTap = useCallback(
    (nodeId: string, pinId: string, direction: "in" | "out") => {
      if (readOnly) {
        onPinSelect?.(nodeId, pinId);
        return;
      }
      if (direction === "out") {
        const next = { nodeId, pinId };
        pendingPinRef.current = next;
        setPendingPin(next);
        return;
      }

      const activePin = pendingPinRef.current;
      if (!activePin) return;
      if (activePin.nodeId === nodeId) {
        setPendingPin(null);
        return;
      }

      addEdge(activePin.nodeId, activePin.pinId, nodeId, pinId);
      pendingPinRef.current = null;
      setPendingPin(null);
    },
    [addEdge, onPinSelect, readOnly],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle ||
        !connection.targetHandle
      ) {
        return;
      }
      addEdge(
        connection.source,
        connection.sourceHandle,
        connection.target,
        connection.targetHandle,
      );
      setPendingPin(null);
      pendingPinRef.current = null;
    },
    [addEdge, readOnly],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle ||
        !connection.targetHandle
      ) {
        return false;
      }
      const sourcePin = pinOnNode(
        graphStateRef.current.nodes,
        connection.source,
        connection.sourceHandle,
      );
      const targetPin = pinOnNode(
        graphStateRef.current.nodes,
        connection.target,
        connection.targetHandle,
      );
      if (!sourcePin || !targetPin) return true;
      if (!pinsAreCompatible(sourcePin, targetPin, pinCompatibility)) {
        return false;
      }
      if (!canConnect) return true;
      return canConnect({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      });
    },
    [canConnect, pinCompatibility],
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
        openedAddNode: false,
      };
    },
    [readOnly],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const openedAddNode =
        suppressPaletteDismissRef.current ||
        connectDragRef.current?.openedAddNode === true;
      connectDragRef.current = null;
      if (readOnly || openedAddNode) return;
      if (state.toHandle) return;
      const fromHandle = state.fromHandle;
      const fromNode = state.fromNode;
      if (!fromHandle?.id || !fromNode) return;
      const pinId = fromHandle.id;
      const point = clientPoint(event);
      if (!point) return;
      const pin = pinOnNode(
        graphStateRef.current.nodes,
        fromNode.id,
        pinId,
      );
      if (!pin) return;
      const root = document;
      const decision = {
        hasTargetHandle: false,
        pointerOverNode: isClientPointOverGraphNode(point, root),
        pointerOverSourceHandle: isClientPointOverHandle(
          point,
          fromNode.id,
          pinId,
          root,
        ),
        pointer: point,
        safePins: screenCentersForSafePins(
          root,
          collectSafeConnectPins(
            nodePinLists(graphStateRef.current.nodes),
            fromNode.id,
            pin,
            pinCompatibility,
          ),
        ),
      };
      const action = connectEndAction(decision, connectEndMode);
      if (action === "add-node") {
        const position = screenToFlowPosition(point);
        setPendingConnect({ pin, nodeId: fromNode.id, position });
        setPaletteOpen(true);
        return;
      }
      if (action !== "break") {
        return;
      }
      setEdges((current) => {
        const next = current.filter(
          (edge) => !edgeTouchesPin(edge, fromNode.id, pinId),
        );
        if (next.length === current.length) return current;
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
      pendingPinRef.current = null;
      setPendingPin(null);
    },
    [connectEndMode, emitChange, pinCompatibility, readOnly, screenToFlowPosition],
  );

  const handleAddPaletteNode = useCallback(
    (paletteNode: PaletteNode) => {
      const position = pendingConnect?.position ??
        screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        });
      const id = `${paletteNode.id}-${Date.now()}`;
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

      setNodes((current) => {
        const next = [
          ...current.map((node) => ({ ...node, selected: false })),
          nextNode,
        ];
        const connect = pendingConnect;
        let nextEdges = graphStateRef.current.edges;
        if (connect?.pin && connect.nodeId) {
          const match = firstCompatiblePin(
            paletteNode.pins,
            connect.pin,
            pinCompatibility,
          );
          if (match) {
            const sourceIsDragged = connect.pin.direction === "out";
            const source = sourceIsDragged ? connect.nodeId : id;
            const sourceHandle = sourceIsDragged ? connect.pin.id : match.id;
            const target = sourceIsDragged ? id : connect.nodeId;
            const targetHandle = sourceIsDragged ? match.id : connect.pin.id;
            const edgeId = createEdgeId(source, sourceHandle, target, targetHandle);
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
              { replaceIncoming: replaceIncomingOnConnect },
            );
            setEdges(nextEdges);
          }
        }
        emitChange(next, nextEdges);
        return next;
      });
      setPendingConnect(null);
    },
    [
      defaultEdgeOptions.type,
      emitChange,
      knownTypes,
      nodeDragHandle,
      pendingConnect,
      pinCompatibility,
      replaceIncomingOnConnect,
      screenToFlowPosition,
    ],
  );

  const selectedNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes],
  );
  const selectionIsOnlyProtected =
    selectedNodes.length > 0 &&
    selectedNodes.every((node) => isProtectedNode(node));
  const hasBreakableLinks = useMemo(() => {
    const selected = new Set(selectedNodes.map((node) => node.id));
    return edgesTouchingNodes(edges, selected).length > 0;
  }, [edges, selectedNodes]);

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const selectionKey = selectedNodes.map((node) => node.id).join("\0");
  useEffect(() => {
    onSelectionChangeRef.current?.(
      selectionKey === "" ? [] : selectionKey.split("\0"),
    );
  }, [selectionKey]);

  const onEdgeSelectionChangeRef = useRef(onEdgeSelectionChange);
  onEdgeSelectionChangeRef.current = onEdgeSelectionChange;
  const selectedEdges = useMemo(
    () => edges.filter((edge) => edge.selected),
    [edges],
  );
  const edgeSelectionKey = selectedEdges.map((edge) => edge.id).join("\0");
  useEffect(() => {
    onEdgeSelectionChangeRef.current?.(
      edgeSelectionKey === "" ? [] : edgeSelectionKey.split("\0"),
    );
  }, [edgeSelectionKey]);

  const copySelection = useCallback(() => {
    const selected = selectedNodes.filter((node) => !isProtectedNode(node));
    if (selected.length === 0) return;
    clipboardRef.current = {
      nodes: selected.map((node) => ({
        ...node,
        data: { ...node.data },
      })),
      edges: graphStateRef.current.edges.filter((edge) => {
        const ids = new Set(selected.map((node) => node.id));
        return ids.has(edge.source) && ids.has(edge.target);
      }),
    };
    setHasClipboard(true);
  }, [selectedNodes]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip) return;
    const pasteable = clip.nodes.filter((node) => !isProtectedNode(node));
    if (pasteable.length === 0) return;
    const idMap = new Map<string, string>();
    const stamp = Date.now();
    const nextNodes = pasteable.map((node, index) => {
      const id = `${node.id}-copy-${stamp}-${index}`;
      idMap.set(node.id, id);
      return withDragHandle(
        {
          ...node,
          id,
          selected: true,
          position: {
            x: node.position.x + PASTE_OFFSET,
            y: node.position.y + PASTE_OFFSET,
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
        },
      ];
    });
    setNodes((current) => {
      const cleared = current.map((node) => ({ ...node, selected: false }));
      const next = [...cleared, ...nextNodes];
      setEdges((currentEdges) => {
        const combined = [...currentEdges, ...nextEdges];
        emitChange(next, combined);
        return combined;
      });
      return next;
    });
  }, [emitChange, nodeDragHandle]);

  const deleteSelection = useCallback(() => {
    const selected = new Set(
      deletableNodeIds(graphStateRef.current.nodes),
    );
    if (selected.size === 0) return;
    setNodes((current) => {
      const nextNodes = current.filter((node) => !selected.has(node.id));
      setEdges((currentEdges) => {
        const nextEdges = currentEdges.filter(
          (edge) => !selected.has(edge.source) && !selected.has(edge.target),
        );
        emitChange(nextNodes, nextEdges);
        return nextEdges;
      });
      return nextNodes;
    });
  }, [emitChange]);

  const breakSelectionLinks = useCallback(() => {
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
      const next = current.map((node) => {
        const position = positions.get(node.id);
        if (
          !position ||
          (position.x === node.position.x && position.y === node.position.y)
        ) {
          return node;
        }
        return { ...node, position };
      });
      emitChange(next, graphStateRef.current.edges);
      return next;
    });
  }, [emitChange]);

  const clearSelection = useCallback(() => {
    setNodes((current) =>
      current.map((node) => ({ ...node, selected: false })),
    );
  }, []);

  const handlePaneClick = useCallback(
    (event: { clientX: number; clientY: number }) => {
      if (skipPaneClickRef.current) {
        skipPaneClickRef.current = false;
        return;
      }
      const pending = pendingPinRef.current;
      if (!readOnly && connectEndMode === "add-node" && pending) {
        const pin = pinOnNode(
          graphStateRef.current.nodes,
          pending.nodeId,
          pending.pinId,
        );
        if (pin) {
          const point = { x: event.clientX, y: event.clientY };
          setPendingConnect({
            pin,
            nodeId: pending.nodeId,
            position: screenToFlowPosition(point),
          });
          setPaletteOpen(true);
          return;
        }
      }
      clearSelection();
      const now = Date.now();
      if (
        now - lastPaneTapRef.current < DOUBLE_TAP_MS &&
        !readOnly &&
        emptyPaneDoubleTapAddsNode
      ) {
        setPendingConnect(null);
        setPaletteOpen(true);
      }
      lastPaneTapRef.current = now;
    },
    [
      clearSelection,
      connectEndMode,
      emptyPaneDoubleTapAddsNode,
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
      if (readOnly || !contextMenuItemsForNode) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".react-flow__node")
      ) {
        return;
      }
      const selected = graphStateRef.current.nodes.find((node) => node.selected);
      if (!selected) return;
      const items = contextMenuItemsForNode(selected.id);
      paneMenu.openMenuAt(event.clientX, event.clientY, items);
    },
    [contextMenuItemsForNode, paneMenu.openMenuAt, readOnly],
  );

  const screenToFlowPositionRef = useRef(screenToFlowPosition);
  screenToFlowPositionRef.current = screenToFlowPosition;
  const pinCompatibilityRef = useRef(pinCompatibility);
  pinCompatibilityRef.current = pinCompatibility;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

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
      },
    });
    return () => handle.dispose();
  }, []);

  useEffect(() => {
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

    const releasePaletteDismissHold = (event: Event) => {
      if (!suppressPaletteDismissRef.current) return;
      paletteDismissHoldIdsRef.current.delete(
        connectEventPointerId(event as MouseEvent | TouchEvent),
      );
      if (paletteDismissHoldIdsRef.current.size > 0) return;
      queueMicrotask(() => {
        if (paletteDismissHoldIdsRef.current.size === 0) {
          suppressPaletteDismissRef.current = false;
        }
      });
    };

    const onSecondaryPointerDown = (event: Event) => {
      const session = connectDragRef.current;
      if (!session || session.openedAddNode || readOnlyRef.current) return;
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".react-flow")) {
        return;
      }
      const eventPointerId = connectEventPointerId(
        event as MouseEvent | TouchEvent,
      );
      if (eventPointerId === session.pointerId) return;
      event.preventDefault();
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
      });
      const inAddNodeZone = shouldOpenAddNodeOnConnectEnd({
        hasTargetHandle: Boolean(
          connection.inProgress && connection.toHandle,
        ),
        pointerOverNode: isClientPointOverGraphNode(pointer),
        pointer,
        safePins: screenCentersForSafePins(
          document,
          collectSafeConnectPins(
            nodePinLists(graphStateRef.current.nodes),
            session.nodeId,
            pin,
            pinCompatibilityRef.current,
          ),
        ),
      });
      if (
        !shouldOpenAddNodeOnSecondaryPointer({
          connectionActive: true,
          dragPointerId: session.pointerId,
          eventPointerId,
          inAddNodeZone,
        })
      ) {
        return;
      }
      const position = connection.inProgress
        ? connection.to
        : screenToFlowPositionRef.current(pointer);
      session.openedAddNode = true;
      suppressPaletteDismissRef.current = true;
      paletteDismissHoldIdsRef.current = new Set([
        session.pointerId,
        eventPointerId,
      ]);
      setPendingConnect({ pin, nodeId: session.nodeId, position });
      setPaletteOpen(true);
      storeApi.getState().cancelConnection();
    };

    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("touchmove", onMove, { capture: true, passive: true });
    document.addEventListener("pointerdown", onSecondaryPointerDown, true);
    document.addEventListener("touchstart", onSecondaryPointerDown, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", releasePaletteDismissHold, true);
    document.addEventListener("mouseup", releasePaletteDismissHold, true);
    document.addEventListener("touchend", releasePaletteDismissHold, true);
    document.addEventListener("pointercancel", releasePaletteDismissHold, true);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("pointerdown", onSecondaryPointerDown, true);
      document.removeEventListener("touchstart", onSecondaryPointerDown, true);
      document.removeEventListener("pointerup", releasePaletteDismissHold, true);
      document.removeEventListener("mouseup", releasePaletteDismissHold, true);
      document.removeEventListener("touchend", releasePaletteDismissHold, true);
      document.removeEventListener(
        "pointercancel",
        releasePaletteDismissHold,
        true,
      );
    };
  }, [storeApi]);

  const pinDisplayTypes = useMemo(
    () => displayPinTypesForGraph(nodes, edges),
    [edges, nodes],
  );

  const pinDisplayType = useCallback(
    (nodeId: string, pinId: string) =>
      pinDisplayTypes.get(pinTypeKey(nodeId, pinId)),
    [pinDisplayTypes],
  );

  const styledEdges = useMemo(
    () => styleFlowEdges(edges, nodes, pinDisplayTypes),
    [edges, nodes, pinDisplayTypes],
  );

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

  const contextValue = useMemo(
    () => ({
      pendingPin,
      onPinTap,
      nodeErrorCount,
      pinHasError,
      pinDisplayType,
      onNavigateRequest,
      selectedAttachmentId,
      onAttachmentSelect,
      onAttachmentDoubleClick,
      contextMenuItemsForNode,
      contextMenuItemsForAttachment,
      onEdgeDoubleClick,
    }),
    [
      nodeErrorCount,
      onNavigateRequest,
      onPinTap,
      pendingPin,
      pinDisplayType,
      pinHasError,
      selectedAttachmentId,
      onAttachmentSelect,
      onAttachmentDoubleClick,
      contextMenuItemsForNode,
      contextMenuItemsForAttachment,
      onEdgeDoubleClick,
    ],
  );

  return (
    <GraphEditorProvider value={contextValue}>
      <div
        ref={wrapperRef}
        className="relative h-full w-full touch-manipulation"
        data-testid="graph-editor"
        data-readonly={readOnly ? "true" : undefined}
        data-nodes-draggable={nodesDraggable ? "true" : "false"}
      >
        {readOnly ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div
            className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-md"
            data-testid="graph-toolbar"
          >
            {hiddenToolbar.has("copy") ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedNodes.length === 0 || selectionIsOnlyProtected}
              onClick={copySelection}
              data-testid="graph-copy"
            >
              Copy
            </Button>
            )}
            {hiddenToolbar.has("paste") ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasClipboard}
              onClick={pasteClipboard}
              data-testid="graph-paste"
            >
              Paste
            </Button>
            )}
            {hiddenToolbar.has("delete") ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedNodes.length === 0 || selectionIsOnlyProtected}
              onClick={deleteSelection}
              data-testid="graph-delete"
            >
              Delete
            </Button>
            )}
            {hiddenToolbar.has("breakLinks") ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasBreakableLinks}
              onClick={breakSelectionLinks}
              title="Break all pin links on selected nodes"
              data-testid="graph-break-links"
            >
              Break Links
            </Button>
            )}
            {hiddenToolbar.has("format") ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedNodes.length === 0}
              onClick={formatSelection}
              title="Format selected nodes, or follow a single node’s then-chain and its data inputs"
              data-testid="graph-format"
            >
              Format
            </Button>
            )}
            {toolbarExtra}
          </div>
        </div>
        )}
        <ReactFlow
          className="graph-editor-canvas"
          colorMode={colorMode}
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={knownTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={nodesDraggable}
          nodesConnectable={!readOnly}
          elementsSelectable
          edgesReconnectable={false}
          onNodesChange={handleNodesChange}
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
          fitView
          fitViewOptions={graphViewport.fitViewOptions}
          defaultViewport={graphViewport.defaultViewport}
          minZoom={graphViewport.minZoom}
          maxZoom={graphViewport.maxZoom}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--border)"
            bgColor="var(--card)"
          />
          <Controls
            showInteractive={false}
            fitViewOptions={graphViewport.fitViewOptions}
          />
          <FocusedNodeSync
            focusedNodeId={focusedNodeId}
            fitViewOptions={graphViewport.focusedFitViewOptions}
          />
        </ReactFlow>
        {marqueeScreen ? (
          <div
            data-testid="graph-marquee"
            className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
          >
            <div
              className="absolute border-2 border-dashed border-primary bg-primary/25"
              style={{
                left: marqueeScreen.x,
                top: marqueeScreen.y,
                width: marqueeScreen.width,
                height: marqueeScreen.height,
              }}
            />
          </div>
        ) : null}
        {readOnly ? null : (
        <NodePalette
          open={paletteOpen}
          onOpenChange={(next) => {
            if (!next && suppressPaletteDismissRef.current) return;
            setPaletteOpen(next);
            if (!next) setPendingConnect(null);
          }}
          paletteNodes={paletteNodes}
          filterPin={pendingConnect?.pin ?? null}
          pinCompatibility={pinCompatibility}
          onAddNode={handleAddPaletteNode}
        />
        )}
        <ContextMenuOverlay menu={paneMenu.menu} onClose={paneMenu.closeMenu} />
      </div>
    </GraphEditorProvider>
  );
}

export function GraphEditor(props: GraphEditorProps) {
  return (
    <ReactFlowProvider>
      <GraphEditorCanvas {...props} />
    </ReactFlowProvider>
  );
}
