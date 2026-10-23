import { BT_DEBUG_GRAPH_ID } from "@haptic/bridge";
import type { GraphRunTrace } from "@haptic/graph-ui";
import type { GraphDebugStore } from "../services/graph-debug-store";

/**
 * What the graph debugger knows about one graph, as its canvas reads it: the runs of the
 * followed instance in the graph with this asset and graph id, and each pin's last value.
 * A graph kind that debugs other instances builds the same from its own ids.
 */
export function createGraphRunTrace(store: GraphDebugStore, assetGuid: string, graphId: string): GraphRunTrace {
  return {
    subscribe: (listener) => store.subscribeTrace((trace) => {
      for (const graph of trace.graphs) {
        if (graph.assetGuid === assetGuid && graph.graphId === graphId) {
          listener({ nodes: graph.nodes, edges: graph.edges });
        }
      }
    }),
    value: (nodeId, pinId, direction) => store.value(assetGuid, graphId, nodeId, pinId, direction),
    subscribeHold: (listener) => store.subscribeHold(listener),
  };
}

/** The same for a Behaviour Tree, whose nodes also carry the status of the followed instance (running, success or failure). */
export function createBehaviourTreeRunTrace(store: GraphDebugStore, treeGuid: string): GraphRunTrace {
  return {
    ...createGraphRunTrace(store, treeGuid, BT_DEBUG_GRAPH_ID),
    status: (nodeId) => store.status(treeGuid, nodeId),
    subscribeStatus: (nodeId, listener) => store.subscribeStatus(nodeId, listener),
  };
}
