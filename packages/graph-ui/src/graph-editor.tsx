import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeChange,
  type NodeTypes,
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
  isProtectedNode,
  lockNodeDragAxis,
  nodeChangesMutateGraph,
  reconcileCanvasGraph,
  toSerializedGraph,
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
  edgesTouchingNodes,
  edgeTouchesPin,
  firstCompatiblePin,
  isClientPointOverGraphNode,
  isClientPointOverHandle,
  nodePinLists,
  pinsAreCompatible,
  screenCentersForSafePins,
  shouldBreakPinConnectionsOnConnectEnd,
  shouldOpenAddNodeOnConnectEnd,
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

export type { GraphDocument, GraphDiagnostic, NavigateRequest, PaletteNode };
export type { SerializedPin } from "./graph-types";
export {
  GRAPH_DEFAULT_ZOOM,
  GRAPH_MAX_ZOOM,
  GRAPH_MIN_ZOOM,
} from "./graph-viewport";

export interface GraphEditorProps {
  initialGraph: GraphDocument;
  onChange?: (graph: GraphDocument) => void;
  /** Selected canvas node ids; not part of the serialized graph. */
  onSelectionChange?: (nodeIds: string[]) => void;
  /** Pin click in read-only previews (does not mutate). */
  onPinSelect?: (nodeId: string, pinId: string) => void;
  focusedNodeId?: string;
  diagnostics?: GraphDiagnostic[];
  onNavigateRequest?: (request: NavigateRequest) => void;
  /** Double-tap / double-click a node (task class navigation). */
  onNodeDoubleClick?: (nodeId: string) => void;
  paletteNodes?: PaletteNode[];
  colorMode?: "light" | "dark";
  defaultZoom?: number;
  /** Pan/zoom only: no connect, node drag, palette, or Cut/Paste/Delete/Format. */
  readOnly?: boolean;
  /** Override or extend the default pin/log node components. */
  nodeTypes?: NodeTypes;
  edgeTypes?: EdgeTypes;
  /** Defaults to `!readOnly`. Behaviour trees pass false except sibling reorder. */
  nodesDraggable?: boolean;
  toolbarExtra?: ReactNode;
  selectedAttachmentId?: string | null;
  onAttachmentSelect?: (id: string | null) => void;
  hiddenToolbarActions?: Array<"copy" | "paste" | "delete" | "breakLinks" | "format">;
  /** Lock node drag to one axis (behaviour-tree sibling reorder). */
  lockNodeDragAxis?: "x" | "y";
  contextMenuItemsForNode?: (nodeId: string) => NestedMenuItem[];
  contextMenuItemsForAttachment?: (
    nodeId: string,
    attachmentId: string,
  ) => NestedMenuItem[];
  onAttachmentDoubleClick?: (nodeId: string, attachmentId: string) => void;
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

function toCanvasNodes(
  nodes: GraphDocument["nodes"],
  knownTypes: NodeTypes,
): CanvasNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: resolveNodeType(node.type, node.data, knownTypes),
    position: node.position,
    data: { ...node.data, __nodeType: node.type },
  }));
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
  onSelectionChange,
  focusedNodeId,
  diagnostics,
  onNavigateRequest,
  onNodeDoubleClick,
  paletteNodes,
  colorMode = "dark",
  defaultZoom = GRAPH_DEFAULT_ZOOM,
  readOnly = false,
  onPinSelect,
  nodeTypes: nodeTypesProp,
  edgeTypes,
  nodesDraggable: nodesDraggableProp,
  toolbarExtra,
  selectedAttachmentId = null,
  onAttachmentSelect,
  hiddenToolbarActions = [],
  lockNodeDragAxis: lockDragAxis,
  contextMenuItemsForNode,
  contextMenuItemsForAttachment,
  onAttachmentDoubleClick,
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
    toCanvasNodes(initialGraph.nodes, knownTypes),
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

  const emitChange = useCallback(
    (nextNodes: CanvasNode[], nextEdges: Edge[]) => {
      const graph = toSerializedGraph(
        nextNodes,
        nextEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
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
      onChange?.(graph);
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
        return {
          id: node.id,
          type: resolveNodeType(typeId, data, knownTypes),
          position: node.position,
          data,
          selected: node.selected,
          measured: node.measured,
          width: node.width,
          height: node.height,
        };
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
        })),
      ),
    );
  }, [initialGraph, knownTypes]);

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
        if (!readOnly && nodeChangesMutateGraph(constrained)) {
          emitChange(next, graphStateRef.current.edges);
        }
        return next;
      });
    },
    [emitChange, lockDragAxis, readOnly],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        emitChange(graphStateRef.current.nodes, next);
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
        if (current.some((edge) => edge.id === id)) {
          return current;
        }
        const next: Edge[] = [
          ...current,
          { id, source, target, sourceHandle, targetHandle },
        ];
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
    },
    [emitChange],
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
      return pinsAreCompatible(sourcePin, targetPin);
    },
    [],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly) return;
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
        pointer: point,
        safePins: screenCentersForSafePins(
          root,
          collectSafeConnectPins(
            nodePinLists(graphStateRef.current.nodes),
            fromNode.id,
            pin,
          ),
        ),
      };
      if (shouldOpenAddNodeOnConnectEnd(decision)) {
        const position = screenToFlowPosition(point);
        setPendingConnect({ pin, nodeId: fromNode.id, position });
        setPaletteOpen(true);
        return;
      }
      if (
        !shouldBreakPinConnectionsOnConnectEnd({
          ...decision,
          pointerOverSourceHandle: isClientPointOverHandle(
            point,
            fromNode.id,
            pinId,
            root,
          ),
        })
      ) {
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
    [emitChange, readOnly, screenToFlowPosition],
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
      if (paletteNode.pins && paletteNode.pins.length > 0) {
        data.__pins = paletteNode.pins;
      }
      const nextNode: CanvasNode = {
        id,
        type: resolveNodeType(
          paletteNode.nodeType ?? paletteNode.id,
          data,
          knownTypes,
        ),
        position,
        selected: true,
        data,
      };

      setNodes((current) => {
        const next = [
          ...current.map((node) => ({ ...node, selected: false })),
          nextNode,
        ];
        const connect = pendingConnect;
        let nextEdges = graphStateRef.current.edges;
        if (connect?.pin && connect.nodeId) {
          const match = firstCompatiblePin(paletteNode.pins, connect.pin);
          if (match) {
            const sourceIsDragged = connect.pin.direction === "out";
            const source = sourceIsDragged ? connect.nodeId : id;
            const sourceHandle = sourceIsDragged ? connect.pin.id : match.id;
            const target = sourceIsDragged ? id : connect.nodeId;
            const targetHandle = sourceIsDragged ? match.id : connect.pin.id;
            const edgeId = createEdgeId(source, sourceHandle, target, targetHandle);
            if (!nextEdges.some((edge) => edge.id === edgeId)) {
              nextEdges = [
                ...nextEdges,
                {
                  id: edgeId,
                  source,
                  target,
                  sourceHandle,
                  targetHandle,
                },
              ];
              setEdges(nextEdges);
            }
          }
        }
        emitChange(next, nextEdges);
        return next;
      });
      setPendingConnect(null);
    },
    [emitChange, pendingConnect, screenToFlowPosition, knownTypes],
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
      return {
        ...node,
        id,
        selected: true,
        position: {
          x: node.position.x + PASTE_OFFSET,
          y: node.position.y + PASTE_OFFSET,
        },
        data: { ...node.data },
      };
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
  }, [emitChange]);

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

  const handlePaneClick = useCallback(() => {
    if (skipPaneClickRef.current) {
      skipPaneClickRef.current = false;
      return;
    }
    clearSelection();
    const now = Date.now();
    if (now - lastPaneTapRef.current < DOUBLE_TAP_MS && !readOnly) {
      setPendingConnect(null);
      setPaletteOpen(true);
    }
    lastPaneTapRef.current = now;
  }, [clearSelection, readOnly]);

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
        {marqueeScreen ? (
          <div
            data-testid="graph-marquee"
            className="pointer-events-none absolute z-20 border border-dashed border-primary bg-primary/15"
            style={{
              left: marqueeScreen.x,
              top: marqueeScreen.y,
              width: marqueeScreen.width,
              height: marqueeScreen.height,
            }}
          />
        ) : null}
        {readOnly ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <div
            className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card/90 p-1 shadow-md"
            data-testid="graph-toolbar"
          >
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
          onConnectEnd={handleConnectEnd}
          onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
          isValidConnection={readOnly ? () => false : isValidConnection}
          onPaneClick={handlePaneClick}
          onPaneContextMenu={handlePaneContextMenu}
          panOnDrag={!marqueeArmed}
          connectionLineStyle={connectionLineStyle}
          connectionLineComponent={GraphConnectionLine}
          defaultEdgeOptions={{ type: "default" }}
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
            bgColor="var(--background)"
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
        {readOnly ? null : (
        <NodePalette
          open={paletteOpen}
          onOpenChange={(next) => {
            setPaletteOpen(next);
            if (!next) setPendingConnect(null);
          }}
          paletteNodes={paletteNodes}
          filterPin={pendingConnect?.pin ?? null}
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
