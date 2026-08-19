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
import type {
  EditorCameraSessionState,
  GizmoTool,
  ViewportShadingMode,
} from "@babylonslate/render";

export type ViewportDropApi = {
  containsClientPoint(clientX: number, clientY: number): boolean;
  worldPositionAtClient(
    clientX: number,
    clientY: number,
  ): [number, number, number] | null;
  worldPositionAtViewCenter(): [number, number, number];
};

export const FALLBACK_PLACE_POSITION: [number, number, number] = [0, 0, 0];

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
  gridVisible: boolean;
  setGridVisible: (visible: boolean) => void;
  /** Live viewport navmesh overlay; persisted via `settings.showNavmesh`. */
  navmeshVisible: boolean;
  setNavmeshVisible: (visible: boolean) => void;
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
  /** Session-only actor shading overlay (PBR / Unlit / Wireframe / Points Cloud). */
  viewportShadingMode: ViewportShadingMode;
  setViewportShadingMode: (mode: ViewportShadingMode) => void;
  frameActor: (actorId: string) => void;
  setFrameActorHandler: (handler: ((actorId: string) => void) | null) => void;
  /** Scene viewport hit-test and screen-to-world for Outliner drop / Place Actors. */
  viewportDropApi: ViewportDropApi;
  setViewportDropApi: (api: ViewportDropApi | null) => void;
  /** Persist editor camera pose across viewport remounts (Focus, layout restore). */
  saveEditorCameraPose: (state: EditorCameraSessionState) => void;
  loadEditorCameraPose: () => EditorCameraSessionState | null;
}

/** In-memory editor camera pose. Pass `documentId` so remounts restore. */
const editorCameraPosesByDocumentId = new Map<
  string,
  EditorCameraSessionState | null
>();

export function createEditorCameraPoseStore(documentId?: string) {
  if (!documentId) {
    let pose: EditorCameraSessionState | null = null;
    return {
      save(state: EditorCameraSessionState | null | undefined) {
        pose = state ?? null;
      },
      load(): EditorCameraSessionState | null {
        return pose;
      },
    };
  }
  return {
    save(state: EditorCameraSessionState | null | undefined) {
      editorCameraPosesByDocumentId.set(documentId, state ?? null);
    },
    load(): EditorCameraSessionState | null {
      return editorCameraPosesByDocumentId.get(documentId) ?? null;
    },
  };
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
  documentViewportMode,
  documentSnapEnabled,
  documentJoystickEnabled,
  documentGridVisible,
  documentNavmeshVisible,
}: {
  children: ReactNode;
  /** When set, camera pose survives workspace unmount for this document. */
  documentId?: string;
  initialViewportMode?: ViewportMode;
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
  const [gizmoTool, setGizmoTool] = useState<GizmoTool>("translate");
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
  const [dragSelectActive, setDragSelectActive] = useState(false);
  const [viewportMode, setViewportMode] = useState<ViewportMode>(
    resolveDocumentViewportMode(documentViewportMode ?? initialViewportMode),
  );
  const [previewGameCamera, setPreviewGameCamera] = useState(false);
  const [pivotAroundCenter, setPivotAroundCenter] = useState(false);
  const [viewportShadingMode, setViewportShadingMode] =
    useState<ViewportShadingMode>("pbr");
  const frameActorHandlerRef = useRef<((actorId: string) => void) | null>(
    null,
  );
  const viewportDropApiRef = useRef<ViewportDropApi | null>(null);
  const cameraPoseStoreRef = useRef(createEditorCameraPoseStore(documentId));

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
      worldPositionAtClient: (clientX, clientY) =>
        viewportDropApiRef.current?.worldPositionAtClient(clientX, clientY) ??
        null,
      worldPositionAtViewCenter: () =>
        viewportDropApiRef.current?.worldPositionAtViewCenter() ??
        FALLBACK_PLACE_POSITION,
    }),
    [],
  );

  const saveEditorCameraPose = useCallback((state: EditorCameraSessionState) => {
    cameraPoseStoreRef.current.save(state);
  }, []);

  const loadEditorCameraPose = useCallback(
    () => cameraPoseStoreRef.current.load(),
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
      joystickEnabled,
      setJoystickEnabled,
      gridVisible,
      setGridVisible,
      navmeshVisible,
      setNavmeshVisible,
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
      gizmoTool,
      gridVisible,
      joystickEnabled,
      loadEditorCameraPose,
      navmeshVisible,
      saveEditorCameraPose,
      selectActor,
      selectedActorIds,
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
