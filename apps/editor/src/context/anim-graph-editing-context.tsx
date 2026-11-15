import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNodeSelection } from "../lib/node-selection";

/* eslint-disable react-refresh/only-export-components -- context module */

/**
 * The Animation Graph canvas last brought forward, which the Inspector follows: the State Machine (Graph, where a
 * transition rule opens in place), the Animation Object script, or a state's graph in its own tab.
 */
export type AnimCanvas = "stateMachine" | "animationObject" | `state:${string}`;

const STATE_CANVAS_PREFIX = "state:";

/** The canvas of a state's graph tab. */
export function animStateCanvas(stateId: string): AnimCanvas {
  return `${STATE_CANVAS_PREFIX}${stateId}`;
}

/** The state whose graph `canvas` is, or null for the State Machine or the Animation Object. */
export function animCanvasStateId(canvas: AnimCanvas): string | null {
  return canvas.startsWith(STATE_CANVAS_PREFIX) ? canvas.slice(STATE_CANVAS_PREFIX.length) : null;
}

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
      canvas,
      setCanvas,
    }),
    [
      canvas,
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
