import { useCallback, useState } from "react";

export interface NodeFocus {
  /** The node a Compiler Results row last focused, for `GraphEditor.focusedNodeId`. */
  focusedNodeId: string | null;
  /** Counts focus requests, for `GraphEditor.focusRequest`. */
  focusRequest: number;
  /** Selects and frames the node, again when it is already the focus. */
  requestFocus: (nodeId: string) => void;
}

/**
 * The graph canvas focus an asset editor's Compiler Results drive. Each request
 * is new, so choosing the same row again frames its node after the view moved.
 */
export function useNodeFocus(): NodeFocus {
  const [focus, setFocus] = useState<{ nodeId: string; request: number } | null>(null);
  const requestFocus = useCallback((nodeId: string) => {
    setFocus((current) => ({ nodeId, request: (current?.request ?? 0) + 1 }));
  }, []);
  return {
    focusedNodeId: focus?.nodeId ?? null,
    focusRequest: focus?.request ?? 0,
    requestFocus,
  };
}
