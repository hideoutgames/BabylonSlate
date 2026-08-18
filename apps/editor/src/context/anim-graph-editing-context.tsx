import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AnimGraphEditingContextValue {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedTransitionId: string | null;
  setSelectedTransitionId: (id: string | null) => void;
  focusedNodeId: string | null;
  focusNode: (nodeId: string) => void;
  openTransitionId: string | null;
  openTransitionRule: (id: string) => void;
  closeTransitionRule: () => void;
}

const AnimGraphEditingContext =
  createContext<AnimGraphEditingContextValue | null>(null);

export function AnimGraphEditingProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [selectedTransitionId, setSelectedTransitionIdState] = useState<
    string | null
  >(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [openTransitionId, setOpenTransitionId] = useState<string | null>(null);
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIdState(id);
    if (id) setSelectedTransitionIdState(null);
  }, []);
  const setSelectedTransitionId = useCallback((id: string | null) => {
    setSelectedTransitionIdState(id);
    if (id) setSelectedIdState(null);
  }, []);
  const focusNode = useCallback((nodeId: string) => {
    setSelectedIdState(nodeId);
    setSelectedTransitionIdState(null);
    setFocusedNodeId(nodeId);
  }, []);
  const openTransitionRule = useCallback((id: string) => {
    setOpenTransitionId(id);
    setSelectedTransitionIdState(id);
  }, []);
  const closeTransitionRule = useCallback(() => {
    setOpenTransitionId(null);
  }, []);
  const value = useMemo<AnimGraphEditingContextValue>(
    () => ({
      selectedId,
      setSelectedId,
      selectedTransitionId,
      setSelectedTransitionId,
      focusedNodeId,
      focusNode,
      openTransitionId,
      openTransitionRule,
      closeTransitionRule,
    }),
    [
      closeTransitionRule,
      focusNode,
      focusedNodeId,
      openTransitionId,
      openTransitionRule,
      selectedId,
      selectedTransitionId,
      setSelectedId,
      setSelectedTransitionId,
    ],
  );
  return (
    <AnimGraphEditingContext.Provider value={value}>
      {children}
    </AnimGraphEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useAnimGraphEditing(): AnimGraphEditingContextValue {
  const context = useContext(AnimGraphEditingContext);
  if (!context) {
    throw new Error(
      "useAnimGraphEditing must be used within AnimGraphEditingProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
