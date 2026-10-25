import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AbstractEngine } from "@babylonjs/core";
import {
  createEngine,
  EDITOR_CANVAS_COLOR_SCHEME,
  NavMeshDebugOverlay,
  type EngineHandle,
} from "@haptic/render";
import type { EnvironmentLightingSettings, SerializedScene } from "@haptic/core";
import { useSceneEditing } from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import type { applyLiveGizmoToActor } from "../lib/gizmo-drag-commit";
import {
  editorDracoPublicBase,
  editorKtx2PublicBase,
  editorMeshoptPublicBase,
} from "../lib/public-engine-assets";
import { createCanvasResizeGuard, waitForCanvasSize } from "../lib/canvas-resize-guard";
import {
  sceneViewportRenderSettings,
  waitForSceneLoadingPaint,
} from "../lib/scene-viewport-load";
import type { ViewportDropReady, ViewportSceneLoadState } from "./use-viewport-scene-load";

export interface ViewportEngineDeps {
  /** The panel's `useId`, which Drop requests address this viewport by. */
  dropViewportId: string;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  engineRef: RefObject<EngineHandle | null>;
  releaseEngineRef: RefObject<(() => void) | null>;
  simulationDetachedRef: RefObject<boolean>;
  engineGenerationRef: RefObject<number>;
  loadTransitionRef: RefObject<number>;
  blockingLoadRef: RefObject<AbortController | null>;
  appliedRenderSettingsRef: RefObject<string | null>;
  environmentSettingsRef: RefObject<EnvironmentLightingSettings | undefined>;
  navDebugRef: RefObject<NavMeshDebugOverlay | null>;
  sceneRef: RefObject<SerializedScene | null>;
  dragStartSceneRef: RefObject<SerializedScene | null>;
  joystickLeaseRef: RefObject<(() => void) | null>;
  /** Read when the Engine is created; a change alone does not recreate it. */
  renderSettingsKey: string;
  /** A change recreates the Engine, as do `reloadVersion` and `overlayTransformBox`. */
  renderMode: "pbr" | "cel";
  reloadVersion: number;
  overlayTransformBox: boolean;
  flySpeed: number;
  commitGizmoTransform: () => void;
  commitPilotedActor: (live: Parameters<typeof applyLiveGizmoToActor>[1]) => void;
  commitComponentShape: (edit: { actorId: string; componentId: string; properties: Record<string, unknown> }) => void;
  setSceneLoad: Dispatch<SetStateAction<ViewportSceneLoadState>>;
  setSceneReady: Dispatch<SetStateAction<boolean>>;
  setDropReady: Dispatch<SetStateAction<ViewportDropReady>>;
  setEngineEpoch: Dispatch<SetStateAction<number>>;
  setNavOverlayGeneration: Dispatch<SetStateAction<number>>;
  setReloadVersion: Dispatch<SetStateAction<number>>;
}

/**
 * Creates the viewport's editor Engine view on the project's shared Engine and
 * releases it on remount: picking, marquee, gizmo and fly callbacks, the
 * navmesh overlay, the render gate and resize observers. Returns the marquee
 * rectangle to draw. React runs its effects in call order, so the panel calls
 * it where these effects have always run.
 */
export function useViewportEngine({
  dropViewportId,
  canvasRef,
  previewCanvasRef,
  engineRef,
  releaseEngineRef,
  simulationDetachedRef,
  engineGenerationRef,
  loadTransitionRef,
  blockingLoadRef,
  appliedRenderSettingsRef,
  environmentSettingsRef,
  navDebugRef,
  sceneRef,
  dragStartSceneRef,
  joystickLeaseRef,
  renderSettingsKey,
  renderMode,
  reloadVersion,
  overlayTransformBox,
  flySpeed,
  commitGizmoTransform,
  commitPilotedActor,
  commitComponentShape,
  setSceneLoad,
  setSceneReady,
  setDropReady,
  setEngineEpoch,
  setNavOverlayGeneration,
  setReloadVersion,
}: ViewportEngineDeps) {
  const {
    selectActor,
    setSelectedActorIds,
    viewportMode,
    gridVisible,
    dragSelectActive,
    setDragSelectActive,
    saveEditorCameraPose,
    loadEditorCameraPose,
  } = useSceneEditing();
  const {
    registerSharedEngine,
    registerScheduler,
    playing,
    ensureSharedEngine,
    sharedEngineGeneration,
  } = usePlay();
  const flySpeedRef = useRef(flySpeed);
  flySpeedRef.current = flySpeed;
  const [sharedEngine, setSharedEngine] = useState<AbstractEngine | null>(null);
  const selectActorRef = useRef(selectActor);
  selectActorRef.current = selectActor;
  const setSelectedActorIdsRef = useRef(setSelectedActorIds);
  setSelectedActorIdsRef.current = setSelectedActorIds;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const dragSelectActiveRef = useRef(dragSelectActive);
  dragSelectActiveRef.current = dragSelectActive;
  const setDragSelectActiveRef = useRef(setDragSelectActive);
  setDragSelectActiveRef.current = setDragSelectActive;
  const setMarqueeRectRef = useRef(setMarqueeRect);
  setMarqueeRectRef.current = setMarqueeRect;
  const commitGizmoTransformRef = useRef(commitGizmoTransform);
  commitGizmoTransformRef.current = commitGizmoTransform;
  const commitPilotedActorRef = useRef(commitPilotedActor);
  commitPilotedActorRef.current = commitPilotedActor;
  const commitComponentShapeRef = useRef(commitComponentShape);
  commitComponentShapeRef.current = commitComponentShape;

  useEffect(() => {
    setSharedEngine(ensureSharedEngine());
  }, [ensureSharedEngine, sharedEngineGeneration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!sharedEngine) {
      // The Engine is gone (a lost device, a backend change, a closed project):
      // a failed load has nothing left to retry; the next Engine loads anew.
      setSceneReady(false);
      setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene" });
      return;
    }
    if (!canvas || simulationDetachedRef.current) return;
    engineGenerationRef.current += 1;
    setSceneReady(false);
    setDropReady(null);
    setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene" });
    const controller = new AbortController();
    blockingLoadRef.current = controller;
    const disposers: Array<() => void> = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const dispose of disposers.reverse()) dispose();
    };
    releaseEngineRef.current = release;
    void (async () => {
      try {
        await waitForCanvasSize(canvas, controller.signal);
        controller.signal.throwIfAborted();
        setSceneLoad({ open: true, progress: 0, phase: "Preparing Scene" });
        await waitForSceneLoadingPaint(controller.signal);
        controller.signal.throwIfAborted();
        setSceneLoad({ open: true, progress: 10, phase: "Realizing Scene" });

        const handle = createEngine(canvas, {
          editor: true,
          renderSettings: sceneViewportRenderSettings(renderSettingsKey, environmentSettingsRef.current),
          editorViewportId: dropViewportId,
          sharedEngine,
          viewportMode,
          overlayTransformBox,
          colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
          ktx2BasePath: editorKtx2PublicBase(),
          dracoBasePath: editorDracoPublicBase(),
          meshoptBasePath: editorMeshoptPublicBase(),
          onPickActor: (actorId, pick) =>
            selectActorRef.current(actorId, pick?.additive === true),
          onMarqueeSelect: (actorIds) => setSelectedActorIdsRef.current(actorIds),
          onMarqueeMove: (rect) => setMarqueeRectRef.current(rect),
          dragSelectActive: () => dragSelectActiveRef.current,
          onDragSelectEnd: () => {
            setDragSelectActiveRef.current(false);
            setMarqueeRectRef.current(null);
          },
          onGizmoDragStart: () => {
            dragStartSceneRef.current = sceneRef.current;
          },
          onGizmoDragEnd: () => commitGizmoTransformRef.current(),
          onComponentShapeEdit: (edit) => commitComponentShapeRef.current(edit),
          editorFlyEnabled: () => !playingRef.current,
          onPilotedActorMoveEnd: (live) => commitPilotedActorRef.current(live),
          editorFlySpeed: () => flySpeedRef.current,
        });
        engineRef.current = handle;
        appliedRenderSettingsRef.current = renderSettingsKey;
        disposers.push(() => {
          joystickLeaseRef.current?.();
          joystickLeaseRef.current = null;
          if (handle.editor) {
            saveEditorCameraPose(handle.editor.camera.exportSessionState());
          }
          handle.dispose();
          if (engineRef.current === handle) engineRef.current = null;
        });
        handle.setPaused(true);
        setEngineEpoch((epoch) => epoch + 1);
        const gridSettings = sceneRef.current?.settings;
        if (gridSettings) {
          handle.editor?.setGridSettings({
            tileSize: gridSettings.grid.tileSize,
            tileSubdivisions: gridSettings.grid.tileSubdivisions,
            cameraBounds2D: gridSettings.cameraBounds2D,
            showGrid: gridVisible,
          });
        }
        handle.editor?.camera.importSessionState(loadEditorCameraPose());
        const navDebug = new NavMeshDebugOverlay(handle.scene);
        navDebugRef.current = navDebug;
        disposers.push(() => {
          navDebug.dispose();
          if (navDebugRef.current === navDebug) navDebugRef.current = null;
        });
        setNavOverlayGeneration((generation) => generation + 1);
        handle.editor?.setPreviewCanvas(previewCanvasRef.current);
        registerSharedEngine(handle.engine);
        disposers.push(() => registerSharedEngine(null));
        const unregisterScheduler = registerScheduler({
          setAlwaysRender: (v) => handle.scheduler.setAlwaysRender(v),
          setPaused: (v) => handle.setPaused(v),
        });
        disposers.push(unregisterScheduler);
        const detachRenderGate = attachViewportRenderGate({
          canvas,
          scheduler: handle.scheduler,
          scaling: handle.scaling,
          setLocalQualityOverrides: (overrides) => handle.setLocalQualityOverrides(overrides),
          setPostProcessingEnabled: (enabled) =>
            handle.setPostProcessingEnabled(enabled),
          setTextureBudget: (bytes, enabled) =>
            handle.setTextureBudget(bytes, enabled),
          setAudioBudget: (bytes, enabled) => handle.setAudioBudget(bytes, enabled),
          setMaxVoices: (maxVoices) => handle.setMaxVoices(maxVoices),
        });
        disposers.push(detachRenderGate);

        const resizeIfSized = createCanvasResizeGuard(() => handle.resize(), {
          onHoldChange: (holding) => handle.scheduler.setResizing(holding),
        });
        disposers.push(() => resizeIfSized.dispose());
        resizeIfSized(canvas);

        const resizeObserver = new ResizeObserver(() => {
          resizeIfSized(canvas);
        });
        disposers.push(() => resizeObserver.disconnect());
        resizeObserver.observe(canvas);

        const intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              resizeIfSized(canvas);
            }
          }
        });
        disposers.push(() => intersectionObserver.disconnect());
        intersectionObserver.observe(canvas);

        const restoreObserver = handle.engine.onContextRestoredObservable.add(() => {
          if (released || controller.signal.aborted) return;
          // Restoration is another blocking transition, including on the same Engine.
          setReloadVersion((version) => version + 1);
        });
        disposers.push(() => handle.engine.onContextRestoredObservable.remove(restoreObserver));
        if (!sceneRef.current) setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene" });
      } catch (error) {
        release();
        if (controller.signal.aborted) return;
        console.error("[viewport] failed to create scene", error);
        setSceneLoad({ open: true, progress: 0, phase: "Realizing Scene", failed: true, error });
      } finally {
        // Keep construction covered until the scene-loading effect takes over.
        if (blockingLoadRef.current === controller && (!engineRef.current || !sceneRef.current)) {
          blockingLoadRef.current = null;
        }
      }
    })();

    return () => {
      controller.abort();
      loadTransitionRef.current += 1;
      release();
      if (releaseEngineRef.current === release) releaseEngineRef.current = null;
    };
    // Mode, selection and tool changes are pushed by useViewportEditorSync.
    // Remount when overlay vs world manipulator kind is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dropViewportId,
    registerSharedEngine,
    registerScheduler,
    sharedEngine,
    overlayTransformBox,
    renderMode,
    reloadVersion,
  ]);

  return { marqueeRect };
}
