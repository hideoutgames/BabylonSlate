import { parseSceneDocumentLayout } from "../shell/scene-document-layout";
import { SceneBrushToolbar } from "../components/scene-brush-toolbar";
import { useSceneTools } from "../context/scene-tools-context";
import { attachSceneBrushInput, type SceneBrushState } from "@haptic/render";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ContextMenuOverlay, useContextMenu } from "@haptic/editor-kit";
import { FocusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  applyViewportJoystickSteer,
  type NavMeshDebugOverlay,
  syncEditorPlayState,
  engineAdapterInfo,
  type EngineHandle,
} from "@haptic/render";
import { type SerializedScene, isSceneWorkspaceKind, requestEditorDrop, engineCommandBus, sceneEnvironmentTextureGuid } from "@haptic/core";
import {
  useActiveDocumentId,
  useDocumentActions,
  useProjectState,
  useRegistryState,
  useOpenDocument,
} from "../context/document-context";
import { useKeybindChord, useKeybindCommand } from "../context/keybind-context";
import { getAppSettingsSnapshot, useDebugMode } from "../context/app-settings-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  FALLBACK_PLACE_POSITION,
  useSceneEditing,
} from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { SceneLoadingDialog } from "../components/scene-loading-dialog";
import { isTestModeEnabled } from "@haptic/vfs";
import { editorViewportPausedForSession } from "../lib/preview-build-handoff";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import { useEditorAudioDebug } from "../lib/use-editor-audio-debug";
import {
  applyLiveGizmoToActor,
  takeGizmoDragScene,
} from "../lib/gizmo-drag-commit";
import { sceneStreamingEditorScene } from "../lib/scene-streaming-editor-labels";
import {
  sceneViewportRenderSettingsKey,
  sceneViewportRenderSettings,
} from "../lib/scene-viewport-load";
import { viewportProbes } from "../services/runtime-probes";
import { clipText } from "../lib/diagnostic-info";
import { formatSceneLoadReport } from "../lib/scene-load-report";
import { useViewportNavmesh } from "./use-viewport-navmesh";
import { useViewportEngine } from "./use-viewport-engine";
import {
  useViewportSceneLoad,
  type ViewportDropReady,
  type ViewportSceneLoadState,
} from "./use-viewport-scene-load";
import { useViewportEditorSync } from "./use-viewport-editor-sync";
import {
  installViewportTestHost,
  publishViewportRenderDiagnostics,
} from "./viewport-test-host";

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const dropViewportId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const releaseEngineRef = useRef<(() => void) | null>(null);
  const simulationDetachedRef = useRef(false);
  const navDebugRef = useRef<NavMeshDebugOverlay | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const dragStartSceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const { applySceneChange } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const activeDocumentId = useActiveDocumentId();
  const {
    selectedActorIds,
    joystickEnabled,
    setFrameActorHandler,
    setViewportDropApi,
  } = useSceneEditing();
  const { flySpeed, dropDistance, editorTextureLodEnabled, editorTextureLodQuality } =
    useEditorViewportPrefs();
  const {
    registerSimulationViewport,
    playing,
    preparing,
    ensureSharedEngine,
    reportSceneViewportLoading,
  } = usePlay();
  const [engineEpoch, setEngineEpoch] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [navOverlayGeneration, setNavOverlayGeneration] = useState(0);
  const joystickLeaseRef = useRef<(() => void) | null>(null);
  const engineGenerationRef = useRef(0);
  const appliedRenderSettingsRef = useRef<string | null>(null);
  const loadTransitionRef = useRef(0);
  const blockingLoadRef = useRef<AbortController | null>(null);
  const [sceneLoad, setSceneLoad] = useState<ViewportSceneLoadState>({ open: false, progress: 0, phase: "Preparing Scene" });
  const [sceneReady, setSceneReady] = useState(false);
  // Play shares the project Engine; it waits for a blocking load to settle.
  const sceneLoading = sceneLoad.open && sceneLoad.failed !== true;
  useEffect(() => {
    if (!sceneLoading || !documentId || !reportSceneViewportLoading) return;
    reportSceneViewportLoading(documentId, true);
    return () => reportSceneViewportLoading(documentId, false);
  }, [documentId, reportSceneViewportLoading, sceneLoading]);
  const [dropReady, setDropReady] = useState<ViewportDropReady>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let sized = canvas.clientWidth > 0 && canvas.clientHeight > 0;
    let retryWhenVisible = false;
    const observer = new ResizeObserver(() => {
      const nextSized = canvas.clientWidth > 0 && canvas.clientHeight > 0;
      if (sized && !nextSized && blockingLoadRef.current) {
        const loading = blockingLoadRef.current;
        blockingLoadRef.current = null;
        retryWhenVisible = true;
        loading.abort();
        setSceneReady(false);
        setDropReady(null);
        setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene" });
        // Disposal rejects an outstanding first-frame promise immediately.
        // Completed inactive viewports retain their handle and resources.
        releaseEngineRef.current?.();
      } else if (!sized && nextSized && retryWhenVisible) {
        retryWhenVisible = false;
        setReloadVersion((version) => version + 1);
      }
      sized = nextSized;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const frameSelection = () => {
    const actorId = selectedActorIds[0];
    if (actorId) {
      engineRef.current?.editor?.frameActor(actorId);
    }
  };
  const frameChord = useKeybindChord("viewport.frameSelection");
  useKeybindCommand("viewport.frameSelection", frameSelection, {
    enabled: selectedActorIds.length > 0,
    scopeRef: panelRef,
  });
  const { menu, closeMenu, bind } = useContextMenu({
    items: [
      {
        id: "reload-scene",
        label: "Reload Scene",
        icon: <RefreshCwIcon />,
        onSelect: () => {
          setReloadVersion((version) => version + 1);
        },
      },
      {
        id: "frame-selection",
        label: "Frame Selection",
        icon: <FocusIcon />,
        shortcut: frameChord,
        onSelect: frameSelection,
      },
    ],
  });

  const doc = useOpenDocument(documentId);
  const sceneMode = doc?.ref.kind === "scene" ? parseSceneDocumentLayout(doc.layout).sceneMode : "design";
  const sceneTools = useSceneTools();
  const overlayTransformBox = doc?.ref.kind === "scene-layer";
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  useEffect(() => {
    const host = panelRef.current;
    if (!host || doc?.ref.kind !== "scene" || !registerSimulationViewport) return;
    return registerSimulationViewport({
      documentId,
      host,
      async suspend() {
        simulationDetachedRef.current = true;
        blockingLoadRef.current?.abort();
        loadTransitionRef.current += 1;
        // An abandoned load reports nothing more, so its dialog would stay open, modal
        // and holding background captures, over the whole Simulation.
        setSceneLoad((current) => current.open ? { open: false, progress: 0, phase: "Preparing Scene" } : current);
        const handle = engineRef.current;
        releaseEngineRef.current?.();
        if (handle) await handle.whenReleased();
      },
      restore() {
        simulationDetachedRef.current = false;
        setReloadVersion((version) => version + 1);
      },
    });
  }, [doc?.ref.kind, documentId, registerSimulationViewport]);

  const editorScene = useMemo(() => scene && sceneStreamingEditorScene(scene, (guid) => {
    void registryEpoch; // Registry headers mutate without replacing the registry.
    const asset = assetRegistry?.getByGuid?.(guid);
    return asset?.header.type === "Scene" ? asset.header.name : undefined;
  }), [scene, assetRegistry, registryEpoch]);
  const brushStateRef = useRef<SceneBrushState | null>(null);
  const group = scene?.settings.foliageGroups?.find((entry) => entry.id === sceneTools.groupId);
  brushStateRef.current = {
    ...sceneTools, scene, mode: sceneMode,
    enabled: activeDocumentId === documentId && sceneReady && !sceneLoad.open && !playing && !preparing,
    group: group ? { ...group, models: group.models.filter((model) => assetRegistry?.getByGuid?.(model.modelGuid)?.header.type === "Model") } : undefined,
  };
  useEffect(() => {
    const handle = engineRef.current; const canvas = canvasRef.current;
    if (!handle || !canvas || sceneMode === "design" || activeDocumentId !== documentId || playing || preparing) return;
    return attachSceneBrushInput(handle, canvas, {
      getState: () => brushStateRef.current!,
      commit: (next, before) => brushStateRef.current?.scene === before ? applySceneChange(documentId, next) : Promise.resolve(false),
      onError: (error) => engineCommandBus.dispatch({ type: "log", message: `Scene brush could not apply: ${String(error)}` }),
    });
  }, [engineEpoch, sceneMode, sceneTools.landscapeTool, sceneTools.foliageTool, documentId, activeDocumentId, playing, preparing, applySceneChange]);
  const audioLibrary = useEditorAudioDebug(Boolean(scene?.actors.some((actor) =>
    selectedActorIds.includes(actor.id) &&
    actor.components.some((component) => component.classId === "AudioComponent"),
  )));
  const requestedRenderSettingsKey = sceneViewportRenderSettingsKey(
    projectDocument?.settings.render,
    scene?.settings.celShading,
    scene?.settings.shadowOverrides,
    scene?.settings.environmentLighting,
    scene?.settings.environmentSource === "skybox" ? "skybox" : scene ? sceneEnvironmentTextureGuid(scene.settings) : null,
  );
  const environmentSettingsKey = JSON.stringify(projectDocument?.settings.render.environmentLighting ?? {});
  const environmentSettingsRef = useRef(projectDocument?.settings.render.environmentLighting);
  environmentSettingsRef.current = projectDocument?.settings.render.environmentLighting;
  const [renderSettingsKey, setRenderSettingsKey] = useState(requestedRenderSettingsKey);
  // Shading changes replace compiled material ownership. Other rendering settings
  // are reconciled by the existing scene quality, lighting and material controllers.
  const renderMode = useMemo(
    () => (JSON.parse(renderSettingsKey) as { mode: "pbr" | "cel" }).mode,
    [renderSettingsKey],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setRenderSettingsKey(requestedRenderSettingsKey), 150);
    return () => window.clearTimeout(timer);
  }, [requestedRenderSettingsKey]);

  useEffect(() => {
    if (requestedRenderSettingsKey !== renderSettingsKey || appliedRenderSettingsRef.current !== renderSettingsKey) return;
    engineRef.current?.setRenderSettings(sceneViewportRenderSettings(renderSettingsKey, environmentSettingsRef.current));
  }, [environmentSettingsKey, requestedRenderSettingsKey, renderSettingsKey, engineEpoch]);

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useViewportNavmesh({ engineRef, sceneRef, navDebugRef, navOverlayGeneration, doc, scene });

  /** Turn the mesh state a gizmo drag left behind into one scene command. */
  const commitGizmoTransform = useCallback(() => {
    const handle = engineRef.current;
    const current = takeGizmoDragScene(dragStartSceneRef);
    const lives = handle?.editor?.selectedActorTransforms() ?? [];
    if (!handle || !current || lives.length === 0) return;
    const byId = new Map(lives.map((live) => [live.actorId, live]));
    const next: SerializedScene = {
      ...current,
      actors: current.actors.map((entry) => {
        const live = byId.get(entry.id);
        if (!live) return entry;
        return applyLiveGizmoToActor(entry, live);
      }),
    };
    void applySceneChange(documentId, next);
  }, [applySceneChange, documentId]);
  /** A paused Game Camera pilot gesture becomes one undoable move of the camera actor. */
  const commitPilotedActor = useCallback((live: Parameters<typeof applyLiveGizmoToActor>[1]) => {
    const current = sceneRef.current;
    if (!current) return;
    void applySceneChange(documentId, {
      ...current,
      actors: current.actors.map((entry) => entry.id === live.actorId ? applyLiveGizmoToActor(entry, live) : entry),
    });
  }, [applySceneChange, documentId]);
  /** A released shape handle becomes one undoable component property change. */
  const commitComponentShape = useCallback((edit: { actorId: string; componentId: string; properties: Record<string, unknown> }) => {
    const current = sceneRef.current;
    if (!current) return;
    void applySceneChange(documentId, {
      ...current,
      actors: current.actors.map((actor) => actor.id !== edit.actorId ? actor : {
        ...actor,
        components: actor.components.map((component) => component.id !== edit.componentId ? component : {
          ...component,
          properties: { ...component.properties, ...edit.properties },
        }),
      }),
    });
  }, [applySceneChange, documentId]);

  const dropDisabled = !sceneReady || dropReady?.scene !== scene ||
    dropReady?.handle !== engineRef.current || playing || preparing || !scene?.actors.some(
    (actor) => !actor.locked && selectedActorIds.includes(actor.id),
  );
  const dropSelection = () => {
    const current = sceneRef.current;
    if (dropDisabled || !current) return;
    const actorIds = current.actors
      .filter((actor) => !actor.locked && selectedActorIds.includes(actor.id))
      .map((actor) => actor.id);
    const transforms = requestEditorDrop(dropViewportId, actorIds, dropDistance);
    if (transforms.length === 0) return;
    const byId = new Map(transforms.map((transform) => [transform.actorId, transform]));
    void applySceneChange(documentId, {
      ...current,
      actors: current.actors.map((actor) => {
        const transform = byId.get(actor.id);
        return transform ? applyLiveGizmoToActor(actor, transform) : actor;
      }),
    });
  };

  const { marqueeRect } = useViewportEngine({
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
  });

  useEffect(() => {
    setFrameActorHandler((actorId) => {
      engineRef.current?.editor?.frameActor(actorId);
    });
    return () => setFrameActorHandler(null);
  }, [setFrameActorHandler]);

  useEffect(() => {
    setViewportDropApi({
      containsClientPoint: (clientX, clientY) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      },
      worldPositionAtClient: (clientX, clientY) =>
        engineRef.current?.editor?.worldPositionAtClient(clientX, clientY) ??
        null,
      worldPositionAtViewCenter: () =>
        engineRef.current?.editor?.worldPositionAtViewCenter() ??
        FALLBACK_PLACE_POSITION,
    });
    return () => setViewportDropApi(null);
  }, [setViewportDropApi]);

  useEffect(() => {
    if (engineRef.current) {
      syncEditorPlayState(
        engineRef.current,
        editorViewportPausedForSession({ playing, preparing }),
      );
      // Keep the view registered so its loading permit can present one frame.
      if (!sceneReady) engineRef.current.setPaused(true);
    }
  }, [playing, preparing, sceneReady, engineEpoch]);

  useViewportSceneLoad({
    scene,
    editorScene,
    scenePath: doc?.ref.path,
    requestedRenderSettingsKey,
    renderSettingsKey,
    engineEpoch,
    dropReady,
    editorTextureLodEnabled,
    editorTextureLodQuality,
    canvasRef,
    engineRef,
    releaseEngineRef,
    simulationDetachedRef,
    blockingLoadRef,
    loadTransitionRef,
    engineGenerationRef,
    appliedRenderSettingsRef,
    environmentSettingsRef,
    setDropReady,
    setSceneReady,
    setSceneLoad,
  });

  useViewportEditorSync({ engineRef, engineEpoch, scene, sceneMode, audioLibrary });

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    return installViewportTestHost({ engineRef, canvasRef, sceneRef, dragStartSceneRef, commitGizmoTransform, ensureSharedEngine });
  }, [commitGizmoTransform, ensureSharedEngine]);

  useEffect(() => {
    // Explicitly opt in for Computer Use's read-only DOM inspection. Ordinary
    // editor sessions and performance fixtures do not serialize diagnostics.
    if (import.meta.env.VITE_TEST_MODE !== "true" || !isTestModeEnabled() ||
      new URLSearchParams(location.search).get("renderDiagnostics") !== "1") return;
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    const handle = engineRef.current;
    if (!panel || !canvas || !handle || !sceneReady || sceneLoad.open ||
      requestedRenderSettingsKey !== renderSettingsKey) return;
    return publishViewportRenderDiagnostics({ panel, canvas, handle, engineRef, requestedRenderSettingsKey });
  }, [engineEpoch, sceneReady, sceneLoad.open, requestedRenderSettingsKey, renderSettingsKey]);

  const debugMode = useDebugMode();
  const loadStartedRef = useRef<number | null>(null);
  useEffect(() => {
    loadStartedRef.current = sceneLoad.open ? (loadStartedRef.current ?? performance.now()) : null;
  }, [sceneLoad.open]);
  /** Read lazily: a failed or disposed Engine may no longer report its adapter. */
  const viewportAdapter = () => {
    const engine = engineRef.current?.engine;
    try { return engine ? engineAdapterInfo(engine) : null; } catch { return null; }
  };
  const copyLoadDetails = () => {
    const render = projectDocument?.settings.render;
    const appSettings = getAppSettingsSnapshot().settings;
    return formatSceneLoadReport({
      surface: "Scene Viewport",
      scene: doc?.ref.path ?? null,
      phase: sceneLoad.phase,
      progress: sceneLoad.failed ? null : sceneLoad.progress,
      failed: sceneLoad.failed === true,
      rendering: sceneLoad.rendering,
      elapsedMs: loadStartedRef.current === null ? null : performance.now() - loadStartedRef.current,
      error: sceneLoad.error,
      gpu: sceneLoad.gpu ?? viewportAdapter(),
      details: [
        `Project rendering: path ${render?.renderPath ?? "default"} · backend ${render?.gpuBackend ?? "default"} · quality ${clipText(JSON.stringify(render?.quality ?? "default"), 160)} · mode ${render?.mode ?? "default"}`,
        `Engine Settings: overrides ${appSettings.renderingOverridesEnabled ? "on" : "off"} · hardware scaling ${appSettings.hardwareScalingLevel} · viewport cap ${appSettings.viewportFrameCap} fps`,
        `Scene: ${scene?.actors.length ?? 0} actors`,
      ],
    });
  };

  const probeStateRef = useRef({ sceneReady, sceneLoad });
  probeStateRef.current = { sceneReady, sceneLoad };
  useEffect(() => documentId ? viewportProbes.register(documentId, {
    ready: () => probeStateRef.current.sceneReady && !probeStateRef.current.sceneLoad.open,
    failed: () => probeStateRef.current.sceneLoad.failed === true,
    phase: () => probeStateRef.current.sceneLoad.open ? probeStateRef.current.sceneLoad.phase : null,
    error: () => probeStateRef.current.sceneLoad.error,
    gpu: () => probeStateRef.current.sceneLoad.gpu ?? viewportAdapter(),
  }) : undefined, [documentId]);

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col bg-background"
      data-testid="viewport-panel"
      aria-busy={requestedRenderSettingsKey !== renderSettingsKey || sceneLoad.open}
      data-scene-ready={sceneReady ? "true" : "false"}
      {...bind}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div
          className="pointer-events-auto toolbar-island"
          data-testid="viewport-panel-frame"
        >
          {sceneMode !== "design" ? <SceneBrushToolbar mode={sceneMode} scene={scene} disabled={!sceneReady || playing || preparing} /> : <ViewportToolbar
            onDrop={dropSelection}
            dropDisabled={dropDisabled}
            showViewportModeToggle={doc?.ref.kind !== "scene-layer"}
            showGameCamera={doc?.ref.kind !== "scene-layer"}
            showGizmoTools={!overlayTransformBox}
          />}
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full min-h-0 min-w-0 w-full flex-1 touch-none"
        data-testid="viewport-canvas"
      />
      {sceneLoad.failed && !sceneLoad.open ? (
        // The failed load released the Engine; keep Retry reachable after Close.
        <Empty
          className="absolute inset-0 rounded-none border-0 bg-background"
          data-testid="viewport-load-failed"
        >
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon />
            </EmptyMedia>
            <EmptyTitle>{sceneLoad.rendering ? "Rendering Update Failed" : "Scene Loading Failed"}</EmptyTitle>
            <EmptyDescription>
              {sceneLoad.phase === "Loading Document"
                ? "The scene document could not be read."
                : "The viewport could not finish loading. Adjust the scene or rendering settings, then retry."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              data-testid="viewport-load-retry"
              onClick={() => setReloadVersion((version) => version + 1)}
            >
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {marqueeRect ? (
        <div
          data-testid="viewport-marquee"
          className="pointer-events-none absolute z-10 border border-dashed border-primary bg-primary/15"
          style={{
            left: marqueeRect.x,
            top: marqueeRect.y,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      ) : null}
      <canvas
        ref={previewCanvasRef}
        hidden
        data-testid="camera-preview"
        className="pointer-events-none absolute bottom-3 right-3 z-10 h-[180px] w-[320px] rounded-md border border-border bg-black object-contain"
      />
      {joystickEnabled ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-start p-4">
          <div className="pointer-events-auto">
            <ViewportJoystick
              speed={flySpeed}
              onFly={(forward, right) => {
                const navigation = engineRef.current?.editor?.navigation;
                if (navigation) applyViewportJoystickSteer(navigation, forward, right);
              }}
              onActiveChange={(active) => {
                const scheduler = engineRef.current?.scheduler;
                if (!scheduler) return;
                if (active) {
                  joystickLeaseRef.current ??=
                    scheduler.acquireContinuous("viewport-joystick");
                } else {
                  joystickLeaseRef.current?.();
                  joystickLeaseRef.current = null;
                }
              }}
            />
          </div>
        </div>
      ) : null}
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <SceneLoadingDialog
        open={sceneLoad.open}
        progress={sceneLoad.progress}
        phase={sceneLoad.phase}
        failed={sceneLoad.failed}
        rendering={sceneLoad.rendering}
        onRetry={() => setReloadVersion((version) => version + 1)}
        onDismiss={() => setSceneLoad((current) => ({ ...current, open: false }))}
        onCopyDetails={debugMode ? copyLoadDetails : undefined}
      />
    </div>
  );
}
