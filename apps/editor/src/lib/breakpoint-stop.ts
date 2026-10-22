import { useMemo } from "react";
import { BREAKPOINT_PAUSE_CODE, type SessionPauseCause } from "@haptic/bridge";
import { documentId, type SerializedGraph } from "@haptic/core";
import { canvasNodeTitle } from "@haptic/graph-ui";
import { useBreakpointStore } from "../context/breakpoints-context";
import { useOpenDocument } from "../context/document-context";
import { classIdForGraphPath } from "../services/script-compiler";

/** Where a Simulation stopped, named for the toolbar: Class, event or function, node and object. */
export type BreakpointStop = {
  className: string;
  /** The event or function the run started from. */
  entryName: string;
  nodeTitle: string;
  /** The object that reached the node; absent when the run had none. */
  objectName?: string;
};

type GraphNodes = SerializedGraph["nodes"];

function findNode(graph: SerializedGraph | null | undefined, nodeId: string): GraphNodes[number] | undefined {
  if (!graph) return undefined;
  const nodes: GraphNodes[] = [graph.nodes, ...Object.values(graph.functionGraphs ?? {}).map((slice) => slice.nodes)];
  for (const list of nodes) {
    const node = list.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return undefined;
}

const titleOf = (node: GraphNodes[number] | undefined) =>
  node ? canvasNodeTitle((node.data ?? {}) as Record<string, unknown>, node.type) : undefined;

/**
 * The names of a breakpoint stop, from the breakpoint as it was set and the Class document the stop
 * opened (its event node's title). Null for any other pause.
 */
export function useBreakpointStop(cause: SessionPauseCause | null | undefined): BreakpointStop | null {
  const store = useBreakpointStore();
  const isStop = cause?.code === BREAKPOINT_PAUSE_CODE && !!cause.assetGuid && !!cause.nodeId;
  const doc = useOpenDocument(isStop ? documentId({ kind: "graph", path: cause!.assetGuid! }) : null);
  return useMemo(() => {
    if (!isStop || !cause) return null;
    const { assetGuid, graphId, nodeId, entryNodeId, instanceLabel } = cause;
    const entry = store?.get({ assetGuid: assetGuid!, graphId: graphId ?? "event-graph", nodeId: nodeId! });
    const graph = (doc?.content ?? null) as SerializedGraph | null;
    return {
      className: entry?.label.className ?? classIdForGraphPath(assetGuid!),
      // A function's runs start at its entry, which is named for the function.
      entryName: graphId && graphId !== "event-graph"
        ? entry?.label.graphName ?? graphId
        : titleOf(entryNodeId ? findNode(graph, entryNodeId) : undefined) ?? "Event Graph",
      nodeTitle: titleOf(findNode(graph, nodeId!)) ?? entry?.label.nodeTitle ?? nodeId!,
      ...(instanceLabel ? { objectName: instanceLabel } : {}),
    };
  }, [cause, doc?.content, isStop, store]);
}

/** One line for the toolbar and its tooltip. */
export function breakpointStopText(stop: BreakpointStop): string {
  return `${stop.className} › ${stop.entryName} › ${stop.nodeTitle}${stop.objectName ? ` on ${stop.objectName}` : ""}`;
}
