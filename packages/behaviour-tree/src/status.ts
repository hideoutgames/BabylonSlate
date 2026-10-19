import type { BtResult, BtStackFrame } from "./types";

/** What a live tree's editor shows for a node. A node with no status has not run since the tree (re)started. */
export type BtNodeStatus = BtResult;

/**
 * The status of each node of a live tree from its evaluation state: `running` for every node on the
 * stack, the running leaf and any node whose result is still running (a Parallel branch that
 * yielded is off the stack but running), else the node's last result.
 */
export function btNodeStatuses(state: {
  lastResults: Readonly<Record<string, string>>;
  btNodeId: string | null;
  stack: readonly Pick<BtStackFrame, "nodeId">[];
}): Map<string, BtNodeStatus> {
  const statuses = new Map<string, BtNodeStatus>();
  for (const [id, result] of Object.entries(state.lastResults)) {
    if (result === "success" || result === "failure" || result === "running") statuses.set(id, result);
  }
  for (const frame of state.stack) statuses.set(frame.nodeId, "running");
  if (state.btNodeId) statuses.set(state.btNodeId, "running");
  return statuses;
}
