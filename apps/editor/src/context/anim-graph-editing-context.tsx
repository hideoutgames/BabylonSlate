import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNodeSelection } from "../lib/node-selection";

/** The graph the Animation Graph editor shows: the Anim Graph, a State Machine or a state's graph. */
export type AnimEditorLocation =
  | { kind: "anim" }
  | { kind: "machine"; machineId: string }
  | { kind: "state"; machineId: string; stateId: string };

/** The Animation Graph canvas last brought forward: the State Machine side (Graph) or the Animation Object script. */
export type AnimCanvas = "stateMachine" | "animationObject";

export interface AnimGraphEditingContextValue {
  /** Every selected state; Details shows the properties they share. */
  selectedIds: readonly string[];
  /** The first selected state. */
  selectedId: string | null;
  /** Selects these states; any selects no transition. */
  setSelectedIds: (ids: readonly string[]) => void;
  setSelectedId: (id: string | null) => void;
  selectedTransitionId: string | null;
  setSelectedTransitionId: (id: string | null) => void;
  focusedNodeId: string | null;
  focusNode: (nodeId: string) => void;
  openTransitionId: string | null;
  openTransitionRule: (id: string) => void;
  closeTransitionRule: () => void;
  /** Where the editor is; null opens the primary State Machine. */
  location: AnimEditorLocation | null;
  /** Shows another graph, closing an open rule and clearing the selection. */
  navigate: (location: AnimEditorLocation) => void;
  /** The canvas the Inspector follows. */
  canvas: AnimCanvas;
  setCanvas: (canvas: AnimCanvas) => void;
}

const AnimGraphEditingContext =
  createContext<AnimGraphEditingContextValue | null>(null);

export function AnimGraphEditingProvider({ children }: { children: ReactNode }) {
  const {
    selectedNodeIds: selectedIds,
    selectedNodeId: selectedId,
    setSelectedNodeIds: setSelectedIdsState,
  } = useNodeSelection();
  const [selectedTransitionId, setSelectedTransitionIdState] = useState<
    string | null
  >(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [openTransitionId, setOpenTransitionId] = useState<string | null>(null);
  const [location, setLocation] = useState<AnimEditorLocation | null>(null);
  const [canvas, setCanvas] = useState<AnimCanvas>("stateMachine");
  const setSelectedIds = useCallback((ids: readonly string[]) => {
    setSelectedIdsState(ids);
    if (ids.length > 0) setSelectedTransitionIdState(null);
  }, [setSelectedIdsState]);
  const setSelectedId = useCallback(
    (id: string | null) => setSelectedIds(id ? [id] : []),
    [setSelectedIds],
  );
  const setSelectedTransitionId = useCallback((id: string | null) => {
    setSelectedTransitionIdState(id);
    if (id) setSelectedIdsState([]);
  }, [setSelectedIdsState]);
  const focusNode = useCallback((nodeId: string) => {
    setSelectedIdsState([nodeId]);
    setSelectedTransitionIdState(null);
    setFocusedNodeId(nodeId);
  }, [setSelectedIdsState]);
  // The open rule's transition is the selection, so Back To State Machine returns to it.
  const openTransitionRule = useCallback((id: string) => {
    setOpenTransitionId(id);
    setSelectedTransitionId(id);
  }, [setSelectedTransitionId]);
  const closeTransitionRule = useCallback(() => {
    setOpenTransitionId(null);
  }, []);
  const navigate = useCallback((next: AnimEditorLocation) => {
    setOpenTransitionId(null);
    setSelectedIdsState([]);
    setSelectedTransitionIdState(null);
    setLocation(next);
  }, [setSelectedIdsState]);
  const value = useMemo<AnimGraphEditingContextValue>(
    () => ({
      selectedIds,
      selectedId,
      setSelectedIds,
      setSelectedId,
      selectedTransitionId,
      setSelectedTransitionId,
      focusedNodeId,
      focusNode,
      openTransitionId,
      openTransitionRule,
      closeTransitionRule,
      location,
      navigate,
      canvas,
      setCanvas,
    }),
    [
      canvas,
      location,
      navigate,
      closeTransitionRule,
      focusNode,
      focusedNodeId,
      openTransitionId,
      openTransitionRule,
      selectedId,
      selectedIds,
      selectedTransitionId,
      setSelectedId,
      setSelectedIds,
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

export function useOptionalAnimGraphEditing(): AnimGraphEditingContextValue | null {
  return useContext(AnimGraphEditingContext);
}
/* eslint-enable react-refresh/only-export-components */
