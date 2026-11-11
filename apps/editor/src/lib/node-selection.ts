import { useCallback, useState } from "react";

/**
 * A graph editor's node selection: every selected node in the canvas's order,
 * and the first of them for what acts on one node (focus, highlight).
 */
export interface NodeSelection {
  selectedNodeIds: readonly string[];
  selectedNodeId: string | null;
  setSelectedNodeIds: (ids: readonly string[]) => void;
  /** Selects one node, or nothing. */
  setSelectedNodeId: (id: string | null) => void;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function useNodeSelection(
  initial: readonly string[] | (() => readonly string[]) = [],
): NodeSelection {
  const [selectedNodeIds, setIds] = useState<readonly string[]>(initial);
  // An unchanged selection keeps its identity, so it re-renders nothing.
  const setSelectedNodeIds = useCallback((ids: readonly string[]) => {
    setIds((current) => (sameIds(current, ids) ? current : [...ids]));
  }, []);
  const setSelectedNodeId = useCallback(
    (id: string | null) => setSelectedNodeIds(id === null ? [] : [id]),
    [setSelectedNodeIds],
  );
  return {
    selectedNodeIds,
    selectedNodeId: selectedNodeIds[0] ?? null,
    setSelectedNodeIds,
    setSelectedNodeId,
  };
}
