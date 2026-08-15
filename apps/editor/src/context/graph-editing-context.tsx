import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useOptionalPrefabEditing } from "./prefab-editing-context";

export interface GraphEditingContextValue {
  selectedNodeIds: string[];
  setSelectedNodeIds: (nodeIds: string[]) => void;
  selectedMemberId: string | null;
  setSelectedMemberId: (id: string | null) => void;
  /** Null means the Class event graph. */
  activeFunctionId: string | null;
  setActiveFunctionId: (id: string | null) => void;
}

const GraphEditingContext = createContext<GraphEditingContextValue | null>(
  null,
);

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * Inspector target: canvas selection first, then Compiler Results / Play focus.
 * Does not fall back to an ExecuteJavaScript node.
 */
export function resolveInspectorNodeId(
  selectedNodeIds: readonly string[],
  focusDiagnosticNodeId?: string,
  playFocusedNodeId?: string | null,
): string | undefined {
  return (
    selectedNodeIds[0] ??
    focusDiagnosticNodeId ??
    playFocusedNodeId ??
    undefined
  );
}

export function GraphEditingProvider({
  children,
  initialSelectedMemberId = null,
  initialSelectedNodeIds = [],
  initialActiveFunctionId = null,
}: {
  children: ReactNode;
  initialSelectedMemberId?: string | null;
  initialSelectedNodeIds?: string[];
  initialActiveFunctionId?: string | null;
}) {
  const setPrefabSelectedId = useOptionalPrefabEditing()?.setSelectedId;
  const [selectedNodeIds, setSelectedNodeIdsState] = useState<string[]>(
    initialSelectedNodeIds,
  );
  const [selectedMemberId, setSelectedMemberIdState] = useState<string | null>(
    initialSelectedMemberId,
  );
  const [activeFunctionId, setActiveFunctionIdState] = useState<string | null>(
    initialActiveFunctionId,
  );

  const setSelectedNodeIds = useCallback(
    (nodeIds: string[]) => {
      setSelectedNodeIdsState((current) =>
        sameIds(current, nodeIds) ? current : nodeIds,
      );
      if (nodeIds.length > 0) {
        setSelectedMemberIdState(null);
        setPrefabSelectedId?.(null);
      }
    },
    [setPrefabSelectedId],
  );

  const setSelectedMemberId = useCallback(
    (id: string | null) => {
      setSelectedMemberIdState(id);
      if (id) {
        setSelectedNodeIdsState([]);
        setPrefabSelectedId?.(null);
      }
    },
    [setPrefabSelectedId],
  );

  const setActiveFunctionId = useCallback((id: string | null) => {
    setActiveFunctionIdState(id);
  }, []);

  const value = useMemo<GraphEditingContextValue>(
    () => ({
      selectedNodeIds,
      setSelectedNodeIds,
      selectedMemberId,
      setSelectedMemberId,
      activeFunctionId,
      setActiveFunctionId,
    }),
    [
      activeFunctionId,
      selectedMemberId,
      selectedNodeIds,
      setActiveFunctionId,
      setSelectedMemberId,
      setSelectedNodeIds,
    ],
  );

  return (
    <GraphEditingContext.Provider value={value}>
      {children}
    </GraphEditingContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useGraphEditing(): GraphEditingContextValue {
  const context = useContext(GraphEditingContext);
  if (!context) {
    throw new Error("useGraphEditing must be used within GraphEditingProvider");
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
