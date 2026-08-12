import {
  createContext,
  useCallback,
  useContext,
  useMemo,
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
  /** Live viewport mode; the scene document holds the per-scene default. */
  viewportMode: ViewportMode;
  setViewportMode: (mode: ViewportMode) => void;
}

const SceneEditingContext = createContext<SceneEditingContextValue | null>(null);

export function SceneEditingProvider({
  children,
  initialViewportMode = "3d",
}: {
  children: ReactNode;
  initialViewportMode?: ViewportMode;
}) {
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [gizmoTool, setGizmoTool] = useState<GizmoTool>("translate");
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [viewportMode, setViewportMode] =
    useState<ViewportMode>(initialViewportMode);

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
      viewportMode,
      setViewportMode,
    }),
    [gizmoTool, selectActor, selectedActorIds, snapEnabled, viewportMode],
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
