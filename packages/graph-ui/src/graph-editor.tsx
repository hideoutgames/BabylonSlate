import {
  Background,
  Controls,
  type Node,
  type NodeProps,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback } from "react";
import type { SerializedGraph } from "@babylonslate/core";
import { deserializeGraph, serializeGraph } from "./graph-serialization";

type LogNodeData = {
  message: string;
};

function LogMessageNode({ data }: NodeProps<Node<LogNodeData>>) {
  return (
    <div className="flex min-h-11 min-w-44 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm">
      <div className="text-xs font-medium text-muted-foreground">Log Message</div>
      <div className="text-sm">{data.message}</div>
    </div>
  );
}

const nodeTypes = {
  logMessage: LogMessageNode,
};

export interface GraphEditorProps {
  initialGraph: SerializedGraph;
  onChange?: (graph: SerializedGraph) => void;
}

export function GraphEditor({ initialGraph, onChange }: GraphEditorProps) {
  const [nodes, , onNodesChange] = useNodesState(
    initialGraph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    })),
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      onChange?.(
        deserializeGraph(
          serializeGraph({
            nodes: nodes.map((n) => ({
              id: n.id,
              type: n.type ?? "logMessage",
              position: n.position,
              data: n.data as Record<string, unknown>,
            })),
            edges: initialGraph.edges,
          }),
        ),
      );
    },
    [initialGraph.edges, nodes, onChange, onNodesChange],
  );

  return (
    <div className="h-full w-full touch-manipulation">
      <ReactFlow
        nodes={nodes}
        edges={initialGraph.edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        fitView
        minZoom={0.4}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
