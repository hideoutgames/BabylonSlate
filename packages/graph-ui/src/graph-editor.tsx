import {
  Background,
  Controls,
  applyNodeChanges,
  type Node,
  type NodeProps,
  ReactFlow,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback } from "react";
import type { SerializedGraph } from "@babylonslate/core";
import { toSerializedGraph } from "./graph-model";

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
  const [nodes, setNodes, onNodesChange] = useNodesState(
    initialGraph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    })),
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      // Apply changes locally before notifying the parent — calling onChange with
      // the pre-update `nodes` closure would overwrite external edits (and journal
      // recovery) with stale positions.
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        onChange?.(toSerializedGraph(next, initialGraph.edges));
        return next;
      });
    },
    [initialGraph.edges, onChange, setNodes],
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
