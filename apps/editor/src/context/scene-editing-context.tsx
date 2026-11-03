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
import type { ViewportMode } from "@haptic/core";
import type {
  EditorCameraSessionState,
  GizmoSpace,
  GizmoTool,
  SurfacePlacement,
  SurfaceRest,
  ViewportShadingMode,
} from "@haptic/render";
import { useEditorSessionState } from "./editor-session-state-context";

export type ViewportDropApi = {
  containsClientPoint(clientX: number, clientY: number): boolean;
  /**
   * Where a new actor dropped at a client point goes: with Place On Surfaces in
   * 3D, the surface a trace from the camera hits within the Placement Trace
   * Distance (or the trace's end); otherwise the view plane. Null without a
   * laid-out viewport.
   */
  placementAtClient(clientX: number, clientY: number): SurfacePlacement | null;
  /** Where a new actor placed without a pointer (Place Actors) goes, traced along the middle of the view. */
  placementAtViewCenter(): SurfacePlacement;
  /**
   * After the viewport has built the placed actors, rest their bounds on the
   * surfaces they hit and commit that under `mergeKey`, the key their
   * placement was committed with, so both are one Undo step.
   */
  restOnSurface(rests: readonly SurfaceRest[], mergeKey: string): void;
};

export const FALLBACK_PLACE_POSITION: [number, number, number] = [0, 0, 0];


export type SceneShapeEditTarget = { actorId: string; componentId: string };

export interface SceneEditingContextValue {
  /** Actor ids selected in the viewport, outliner and details panel. */
  selectedActorIds: string[];
  selectActor: (actorId: string | null, additive?: boolean) => void;
  setSelectedActorIds: (actorIds: string[]) => void;
  /** Session-only component whose shape handles override the selected actor's default. */
  shapeEditTarget: SceneShapeEditTarget | null;
  setShapeEditTarget: (target: SceneShapeEditTarget | null) => void;
  gizmoTool: GizmoTool;
  setGizmoTool: (tool: GizmoTool) => void;
  /** Move/rotate handle orientation; scale always uses local axes. */
  gizmoSpace: GizmoSpace;
  setGizmoSpace: (space: GizmoSpace) => void;
  snapEnabled: boolean;
  setSnapEnabled: (enabled: boolean) => void;
  joystickEnabled: boolean;
  setJoystickEnabled: (enabled: boolean) => void;
  gridVisible: boolean;
  setGridVisible: (visible: boolean) => void;
  /** Live viewport navmesh overlay; persisted via `settings.showNavmesh`. */
  navmeshVisible: boolean;
  setNavmeshVisible: (visible: boolean) => void;
  /** Session-only MeshComponent collision dashes. Default off. */
  collisionsVisible: boolean;
  setCollisionsVisible: (visible: boolean) => void;
  /** One-shot Drag Select; unpresses after the next tap or marquee. */
  dragSelectActive: boolean;
  setDragSelectActive: (active: boolean) => void;
  /** Live viewport mode; the scene document holds the per-scene default. */
  viewportMode: ViewportMode;
  setViewportMode: (mode: ViewportMode) => void;
  /** Session-only Game Camera preview of the named Default Camera. */
  previewGameCamera: boolean;
  setPreviewGameCamera: (enabled: boolean) => void;
  /** Session-only 3D orbit around the current look-at point. */
  pivotAroundCenter: boolean;
  setPivotAroundCenter: (enabled: boolean) => void;
  /** Session-only actor shading overlay (PBR / Unlit / Wireframe). */
  viewportShadingMode: ViewportShadingMode;
  setViewportShadingMode: (mode: ViewportShadingMode) => void;
  frameActor: (actorId: string) => void;
  setFrameActorHandler: (handler: ((actorId: string) => void) | null) => void;
  /** Scene viewport hit-test and screen-to-world for Outliner drop / Place Actors. */
  viewportDropApi: ViewportDropApi;
  setViewportDropApi: (api: ViewportDropApi | null) => void;
  /**
   * Editor camera pose across viewport remounts (Focus, Windows, idle-unmount,
   * closing and reopening the tab) for the rest of the project session.
   */
  saveEditorCameraPose: (state: EditorCameraSessionState) => void;
  loadEditorCameraPose: () => EditorCameraSessionState | null;
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
  documentId,
  initialViewportMode = "3d",
  initialViewportShadingMode = "pbr",
  documentViewportMode,
  documentSnapEnabled,
  documentJoystickEnabled,
  documentGridVisible,
  documentNavmeshVisible,
}: {
  children: ReactNode;
  /**
   * When set, the camera pose is kept in the project session store for this
   * document; without it the pose lives only as long as this provider.
   */
  documentId?: string;
  initialViewportMode?: ViewportMode;
  initialViewportShadingMode?: ViewportShadingMode;
  /** When the scene document's viewportMode changes (undo/redo/load), sync live mode. */
  documentViewportMode?: ViewportMode;
  /** When the scene document's grid.snapEnabled changes, sync the toolbar toggle. */
  documentSnapEnabled?: boolean;
  /** When the scene document's editorJoystickEnabled changes, sync the toolbar. */
  documentJoystickEnabled?: boolean;
  /** When the scene document's grid.showGrid changes, sync the toolbar toggle. */
  documentGridVisible?: boolean;
  /** When the scene document's showNavmesh changes, sync the toolbar toggle. */
  documentNavmeshVisible?: boolean;
}) {
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [shapeEditTarget, setShapeEditTarget] = useState<SceneShapeEditTarget | null>(null);
  const [gizmoTool, setGizmoTool] = useState<GizmoTool>("translate");
  const [gizmoSpace, setGizmoSpace] = useState<GizmoSpace>("world");
  const [snapEnabled, setSnapEnabled] = useState(
    documentSnapEnabled ?? false,
  );
  const [joystickEnabled, setJoystickEnabled] = useState(
    documentJoystickEnabled ?? true,
  );
  const [gridVisible, setGridVisible] = useState(
    documentGridVisible ?? true,
  );
  const [navmeshVisible, setNavmeshVisible] = useState(
    documentNavmeshVisible ?? false,
  );
  const [collisionsVisible, setCollisionsVisible] = useState(false);
  const [dragSelectActive, setDragSelectActive] = useState(false);
  const [viewportMode, setViewportMode] = useState<ViewportMode>(
    resolveDocumentViewportMode(documentViewportMode ?? initialViewportMode),
  );
  const [previewGameCamera, setPreviewGameCamera] = useState(false);
  const [pivotAroundCenter, setPivotAroundCenter] = useState(false);
  const [viewportShadingMode, setViewportShadingMode] =
    useState<ViewportShadingMode>(initialViewportShadingMode);
  const frameActorHandlerRef = useRef<((actorId: string) => void) | null>(
    null,
  );
  const viewportDropApiRef = useRef<ViewportDropApi | null>(null);
  const sessionState = useEditorSessionState();
  const localCameraPoseRef = useRef<EditorCameraSessionState | null>(null);

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

  useEffect(() => {
    if (documentGridVisible === undefined) return;
    setGridVisible(documentGridVisible);
  }, [documentGridVisible]);

  useEffect(() => {
    if (documentNavmeshVisible === undefined) return;
    setNavmeshVisible(documentNavmeshVisible);
  }, [documentNavmeshVisible]);

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

  const setViewportDropApi = useCallback((api: ViewportDropApi | null) => {
    viewportDropApiRef.current = api;
  }, []);

  const viewportDropApi = useMemo<ViewportDropApi>(
    () => ({
      containsClientPoint: (clientX, clientY) =>
        viewportDropApiRef.current?.containsClientPoint(clientX, clientY) ??
        false,
      placementAtClient: (clientX, clientY) =>
        viewportDropApiRef.current?.placementAtClient(clientX, clientY) ??
        null,
      placementAtViewCenter: () =>
        viewportDropApiRef.current?.placementAtViewCenter() ??
        { position: FALLBACK_PLACE_POSITION, normal: null },
      restOnSurface: (rests, mergeKey) =>
        viewportDropApiRef.current?.restOnSurface(rests, mergeKey),
    }),
    [],
  );

  // A viewport saves on engine release, which can run after this workspace
  // was renamed; the session store forwards that write to the new id.
  const saveEditorCameraPose = useCallback(
    (state: EditorCameraSessionState) => {
      if (documentId) sessionState.saveCameraPose(documentId, state);
      else localCameraPoseRef.current = state;
    },
    [documentId, sessionState],
  );

  const loadEditorCameraPose = useCallback(
    () =>
      documentId
        ? sessionState.loadCameraPose(documentId)
        : localCameraPoseRef.current,
    [documentId, sessionState],
  );

  const value = useMemo<SceneEditingContextValue>(
    () => ({
      selectedActorIds,
      selectActor,
      setSelectedActorIds,
      shapeEditTarget,
      setShapeEditTarget,
      gizmoTool,
      setGizmoTool,
      gizmoSpace,
      setGizmoSpace,
      snapEnabled,
      setSnapEnabled,
      joystickEnabled,
      setJoystickEnabled,
      gridVisible,
      setGridVisible,
      navmeshVisible,
      setNavmeshVisible,
      collisionsVisible,
      setCollisionsVisible,
      dragSelectActive,
      setDragSelectActive,
      viewportMode,
      setViewportMode,
      previewGameCamera,
      setPreviewGameCamera,
      pivotAroundCenter,
      setPivotAroundCenter,
      viewportShadingMode,
      setViewportShadingMode,
      frameActor,
      setFrameActorHandler,
      viewportDropApi,
      setViewportDropApi,
      saveEditorCameraPose,
      loadEditorCameraPose,
    }),
    [
      dragSelectActive,
      frameActor,
      gizmoSpace,
      gizmoTool,
      gridVisible,
      joystickEnabled,
      loadEditorCameraPose,
      navmeshVisible,
      collisionsVisible,
      saveEditorCameraPose,
      selectActor,
      selectedActorIds,
      shapeEditTarget,
      setFrameActorHandler,
      setViewportDropApi,
      snapEnabled,
      viewportDropApi,
      viewportMode,
      previewGameCamera,
      pivotAroundCenter,
      viewportShadingMode,
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

export function useOptionalSceneEditing(): SceneEditingContextValue | null {
  return useContext(SceneEditingContext);
}
/* eslint-enable react-refresh/only-export-components */
