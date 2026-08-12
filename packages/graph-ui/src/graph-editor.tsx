import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph-editor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasSerializedPins,
  type GraphDiagnostic,
  type GraphDocument,
  type NavigateRequest,
  type PaletteNode,
} from "./graph-types";
import { GraphEditorProvider } from "./graph-editor-context";
import { createEdgeId, toSerializedGraph } from "./graph-model";
import {
  type CanvasNode,
  graphNodeTypes,
  resolveNodeType,
} from "./graph-nodes";
import { edgeStyleForPin } from "./node-theme";
import { NodePalette } from "./node-palette";

export type { GraphDocument, GraphDiagnostic, NavigateRequest, PaletteNode };
export type { SerializedPin } from "./graph-types";

export interface GraphEditorProps {
  initialGraph: GraphDocument;
  onChange?: (graph: GraphDocument) => void;
  focusedNodeId?: string;
  diagnostics?: GraphDiagnostic[];
  onNavigateRequest?: (request: NavigateRequest) => void;
  paletteNodes?: PaletteNode[];
}

function toFlowEdges(edges: GraphDocument["edges"]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }));
}

function styleFlowEdges(edges: Edge[], nodes: CanvasNode[]): Edge[] {
  return edges.map((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const pins = hasSerializedPins(source?.data) ? source.data.__pins : [];
    const pin = pins.find((entry) => entry.id === edge.sourceHandle);
    return {
      ...edge,
      style: edgeStyleForPin(pin?.type),
    };
  });
}

function toCanvasNodes(nodes: GraphDocument["nodes"]): CanvasNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: resolveNodeType(node.type, node.data),
    position: node.position,
    data: { ...node.data, __nodeType: node.type },
  }));
}

function FocusedNodeSync({ focusedNodeId }: { focusedNodeId?: string }) {
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
      padding: 0.35,
      duration: 250,
      maxZoom: 1.2,
    });
  }, [fitView, focusedNodeId, getNode, setNodes]);

  return null;
}

function GraphEditorCanvas({
  initialGraph,
  onChange,
  focusedNodeId,
  diagnostics,
  onNavigateRequest,
  paletteNodes,
}: GraphEditorProps) {
  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    toCanvasNodes(initialGraph.nodes),
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
  const { screenToFlowPosition } = useReactFlow();
  const graphStateRef = useRef({ nodes, edges });
  graphStateRef.current = { nodes, edges };

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

  const emitChange = useCallback(
    (nextNodes: CanvasNode[], nextEdges: Edge[]) => {
      onChange?.(
        toSerializedGraph(
          nextNodes,
          nextEdges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle ?? undefined,
            targetHandle: edge.targetHandle ?? undefined,
          })),
        ),
      );
    },
    [onChange],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        emitChange(next, graphStateRef.current.edges);
        return next;
      });
    },
    [emitChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        emitChange(graphStateRef.current.nodes, next);
        return next;
      });
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
    [addEdge],
  );

  const handleAddPaletteNode = useCallback(
    (paletteNode: PaletteNode) => {
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const id = `${paletteNode.id}-${Date.now()}`;
      const data: Record<string, unknown> = {
        ...(paletteNode.defaultData ?? {}),
        title: paletteNode.title,
        __nodeType: paletteNode.id,
        __category: paletteNode.category,
        __pure: paletteNode.pure ?? false,
        __latent: paletteNode.latent ?? false,
      };
      if (paletteNode.pins && paletteNode.pins.length > 0) {
        data.__pins = paletteNode.pins;
      }
      const nextNode: CanvasNode = {
        id,
        type: resolveNodeType(paletteNode.id, data),
        position,
        data,
      };

      setNodes((current) => {
        const next = [...current, nextNode];
        emitChange(next, graphStateRef.current.edges);
        return next;
      });
    },
    [emitChange, screenToFlowPosition],
  );

  const styledEdges = useMemo(
    () => styleFlowEdges(edges, nodes),
    [edges, nodes],
  );

  const connectionLineStyle = useMemo(() => {
    if (!pendingPin) {
      return edgeStyleForPin({ kind: "exec" });
    }
    const source = nodes.find((node) => node.id === pendingPin.nodeId);
    const pins = hasSerializedPins(source?.data) ? source.data.__pins : [];
    const pin = pins.find((entry) => entry.id === pendingPin.pinId);
    return edgeStyleForPin(pin?.type);
  }, [nodes, pendingPin]);

  const contextValue = useMemo(
    () => ({
      pendingPin,
      onPinTap,
      nodeErrorCount,
      pinHasError,
      onNavigateRequest,
    }),
    [nodeErrorCount, onNavigateRequest, onPinTap, pendingPin, pinHasError],
  );

  return (
    <GraphEditorProvider value={contextValue}>
      <div className="relative h-full w-full touch-manipulation">
        <ReactFlow
          className="graph-editor-canvas"
          colorMode="dark"
          nodes={nodes}
          edges={styledEdges}
          nodeTypes={graphNodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          connectionLineStyle={connectionLineStyle}
          defaultEdgeOptions={{ type: "default" }}
          fitView
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--border)"
            bgColor="var(--background)"
          />
          <Controls showInteractive={false} />
          <FocusedNodeSync focusedNodeId={focusedNodeId} />
        </ReactFlow>
        <NodePalette
          paletteNodes={paletteNodes}
          onAddNode={handleAddPaletteNode}
        />
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
