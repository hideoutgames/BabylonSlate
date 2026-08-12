import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ViewportMode } from "@babylonslate/core";
import type { GizmoTool } from "@babylonslate/render";

export interface SceneEditingContextValue {
  /** Actor ids selected in the viewport, outliner and details panel. */
  selectedActorIds: string[];
  selectActor: (actorId: string | null, additive?: boolean) => void;
  setSelectedActorIds: (actorIds: string[]) => void;
  isSelected: (actorId: string) => boolean;
  gizmoTool: GizmoTool;
  setGizmoTool: (tool: GizmoTool) => void;
  snapEnabled: boolean;
  setSnapEnabled: (enabled: boolean) => void;
  joystickEnabled: boolean;
  setJoystickEnabled: (enabled: boolean) => void;
  /** Live viewport mode; the scene document holds the per-scene default. */
  viewportMode: ViewportMode;
  setViewportMode: (mode: ViewportMode) => void;
  frameActor: (actorId: string) => void;
  setFrameActorHandler: (handler: ((actorId: string) => void) | null) => void;
}

const SceneEditingContext = createContext<SceneEditingContextValue | null>(null);

/**
 * Keep live viewport mode aligned with the scene document so undo/redo of
 * SetViewportModeCommand restores the camera, not only the serialized field.
 */
export function resolveDocumentViewportMode(
  mode: ViewportMode | undefined | null,
): ViewportMode {
  return mode === "2d" ? "2d" : "3d";
}

/** Drop a newly locked actor from the live selection; unlock does not reselect. */
export function selectionAfterLockChange(
  selectedActorIds: readonly string[],
  actorId: string,
  locked: boolean,
): string[] {
  if (!locked) return [...selectedActorIds];
  return selectedActorIds.filter((id) => id !== actorId);
}

export function SceneEditingProvider({
  children,
  initialViewportMode = "3d",
  documentViewportMode,
  documentSnapEnabled,
  documentJoystickEnabled,
}: {
  children: ReactNode;
  initialViewportMode?: ViewportMode;
  /** When the scene document's viewportMode changes (undo/redo/load), sync live mode. */
  documentViewportMode?: ViewportMode;
  /** When the scene document's grid.snapEnabled changes, sync the toolbar toggle. */
  documentSnapEnabled?: boolean;
  /** When the scene document's editorJoystickEnabled changes, sync the toolbar. */
  documentJoystickEnabled?: boolean;
}) {
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [gizmoTool, setGizmoTool] = useState<GizmoTool>("translate");
  const [snapEnabled, setSnapEnabled] = useState(
    documentSnapEnabled ?? false,
  );
  const [joystickEnabled, setJoystickEnabled] = useState(
    documentJoystickEnabled ?? false,
  );
  const [viewportMode, setViewportMode] = useState<ViewportMode>(
    resolveDocumentViewportMode(documentViewportMode ?? initialViewportMode),
  );
  const frameActorHandlerRef = useRef<((actorId: string) => void) | null>(
    null,
  );

  useEffect(() => {
    if (documentViewportMode === undefined) return;
    setViewportMode(resolveDocumentViewportMode(documentViewportMode));
  }, [documentViewportMode]);

  useEffect(() => {
    if (documentSnapEnabled === undefined) return;
    setSnapEnabled(documentSnapEnabled);
  }, [documentSnapEnabled]);

  useEffect(() => {
    if (documentJoystickEnabled === undefined) return;
    setJoystickEnabled(documentJoystickEnabled);
  }, [documentJoystickEnabled]);

  const selectActor = useCallback(
    (actorId: string | null, additive = false) => {
      setSelectedActorIds((current) => {
        if (actorId === null) return [];
        if (!additive) return [actorId];
        return current.includes(actorId)
          ? current.filter((id) => id !== actorId)
          : [...current, actorId];
      });
    },
    [],
  );

  const setFrameActorHandler = useCallback(
    (handler: ((actorId: string) => void) | null) => {
      frameActorHandlerRef.current = handler;
    },
    [],
  );

  const frameActor = useCallback((actorId: string) => {
    frameActorHandlerRef.current?.(actorId);
  }, []);

  const value = useMemo<SceneEditingContextValue>(
    () => ({
      selectedActorIds,
      selectActor,
      setSelectedActorIds,
      isSelected: (actorId: string) => selectedActorIds.includes(actorId),
      gizmoTool,
      setGizmoTool,
      snapEnabled,
      setSnapEnabled,
      joystickEnabled,
      setJoystickEnabled,
      viewportMode,
      setViewportMode,
      frameActor,
      setFrameActorHandler,
    }),
    [
      frameActor,
      gizmoTool,
      joystickEnabled,
      selectActor,
      selectedActorIds,
      setFrameActorHandler,
      snapEnabled,
      viewportMode,
    ],
  );

  return (
    <SceneEditingContext.Provider value={value}>
      {children}
    </SceneEditingContext.Provider>
  );
}

// Context modules intentionally export the provider plus consumer hooks.
/* eslint-disable react-refresh/only-export-components -- context module */
export function useSceneEditing(): SceneEditingContextValue {
  const context = useContext(SceneEditingContext);
  if (!context) {
    throw new Error("useSceneEditing must be used within SceneEditingProvider");
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
