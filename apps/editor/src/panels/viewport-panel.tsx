import { registerScenePipelineStatus, scenePipelineKey } from "../lib/scene-pipeline-status";
import type { AbstractEngine } from "@babylonjs/core";
import { EngineStore, Vector3 } from "@babylonjs/core";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ContextMenuOverlay, useContextMenu } from "@babylonslate/editor-kit";
import {
  applyGizmoMultiSelectDrag,
  applyViewportJoystickSteer,
  beginGizmoMultiSelectDrag,
  collectNavBakeGeometry,
  createEngine,
  captureShadowDiagnostics,
  EDITOR_CANVAS_COLOR_SCHEME,
  NavMeshDebugOverlay,
  navDebugBlockersFromActors,
  navmeshOverlayEnabled,
  selectionGizmoRoots,
  syncEditorPlayState,
  type EngineHandle,
  type EditorSceneLoadOptions,
} from "@babylonslate/render";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import { bakeRuntimeAssetReader } from "@babylonslate/assets";
import { type SerializedScene, areaEmissionTextureGuids, isSceneWorkspaceKind, requestEditorDrop } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { subscribeAppSettings } from "../context/app-settings-context";
import {
  materialViewportTestSnapshot,
  type MaterialViewportTestSnapshot,
} from "../lib/material-viewport-test-snapshot";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  FALLBACK_PLACE_POSITION,
  useSceneEditing,
} from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import { useOptionalSceneBake } from "../context/scene-bake-context";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { SceneLoadingDialog } from "../components/scene-loading-dialog";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { editorViewportPausedForSession } from "../lib/preview-build-handoff";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import { useEditorAudioDebug } from "../lib/use-editor-audio-debug";
import {
  applyLiveGizmoToActor,
  takeGizmoDragScene,
} from "../lib/gizmo-drag-commit";
import {
  editorDracoPublicBase,
  editorKtx2PublicBase,
  editorMeshoptPublicBase,
} from "../lib/public-engine-assets";
import { createCanvasResizeGuard, waitForCanvasSize } from "../lib/canvas-resize-guard";
import {
  modelSlotMaterialGuidsFromPayloads,
  overlayTextureGuidsFromScene,
  skyboxFaceGuidsFromScene,
  environmentTextureGuidsFromScenes,
  postProcessTextureGuidsFromScenes,
} from "../lib/play-content";
import { fontMsdfMapsFromPairs } from "../lib/play-fonts";
import { savedMaterialLibraryKey } from "../lib/material-asset-revision";
import { savedAreaEmissionKey } from "../lib/collect-area-emissions";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
  sceneViewportRenderSettingsKey,
  sceneViewportRenderSettings,
  waitForSceneLoadingPaint,
  type SceneViewportLoadPhase,
} from "../lib/scene-viewport-load";

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const dropViewportId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const releaseEngineRef = useRef<(() => void) | null>(null);
  const navDebugRef = useRef<NavMeshDebugOverlay | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const appliedSceneRef = useRef<{ scene: SerializedScene; handle: EngineHandle } | null>(null);
  const dragStartSceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const {
    openDocuments,
    applySceneChange,
    projectDocument,
    projectGuid,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayAreaEmissions,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    readAssetChunk,
    assetRegistry,
  } = useDocuments();
  const {
    selectedActorIds,
    selectActor,
    setSelectedActorIds,
    gizmoTool,
    snapEnabled,
    viewportMode,
    joystickEnabled,
    gridVisible,
    navmeshVisible,
    dragSelectActive,
    setDragSelectActive,
    setFrameActorHandler,
    setViewportDropApi,
    previewGameCamera,
    saveEditorCameraPose,
    loadEditorCameraPose,
    pivotAroundCenter,
    viewportShadingMode,
    collisionsVisible,
  } = useSceneEditing();
  const { flySpeed, dropDistance, editorTextureLodEnabled, editorTextureLodQuality } =
    useEditorViewportPrefs();
  const flySpeedRef = useRef(flySpeed);
  flySpeedRef.current = flySpeed;
  const {
    registerSharedEngine,
    registerScheduler,
    playing,
    preparing,
    ensureSharedEngine,
    sharedEngineGeneration,
  } = usePlay();
  const [sharedEngine, setSharedEngine] = useState<AbstractEngine | null>(null);
  const [engineEpoch, setEngineEpoch] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const navBake = useOptionalNavBake();
  const sceneBake = useOptionalSceneBake();
  const [navOverlayGeneration, setNavOverlayGeneration] = useState(0);
  const selectActorRef = useRef(selectActor);
  selectActorRef.current = selectActor;
  const setSelectedActorIdsRef = useRef(setSelectedActorIds);
  setSelectedActorIdsRef.current = setSelectedActorIds;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const joystickLeaseRef = useRef<(() => void) | null>(null);
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
  const engineGenerationRef = useRef(0);
  const completedLoadGenerationRef = useRef(-1);
  const completedRenderSettingsRef = useRef<string | null>(null);
  const appliedRenderSettingsRef = useRef<string | null>(null);
  const loadTransitionRef = useRef(0);
  const blockingLoadRef = useRef<AbortController | null>(null);
  const [sceneLoad, setSceneLoad] = useState<{
    open: boolean;
    progress: number;
    phase: SceneViewportLoadPhase;
    failed?: boolean;
    rendering?: boolean;
  }>({ open: false, progress: 0, phase: "Preparing Scene" });
  const [sceneReady, setSceneReady] = useState(false);
  const [dropReady, setDropReady] = useState<{
    scene: SerializedScene;
    handle: EngineHandle;
  } | null>(null);

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

  const { menu, closeMenu, bind } = useContextMenu({
    items: [
      {
        id: "reload-scene",
        label: "Reload Scene",
        onSelect: () => {
          setReloadVersion((version) => version + 1);
        },
      },
      {
        id: "frame-selection",
        label: "Frame Selection",
        onSelect: () => {
          const actorId = selectedActorIds[0];
          if (actorId) {
            engineRef.current?.editor?.frameActor(actorId);
          }
        },
      },
    ],
  });

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const overlayTransformBox = doc?.ref.kind === "scene-layer";
  const scene = isSceneWorkspaceKind(doc?.ref.kind)
    ? (doc.content as SerializedScene)
    : null;
  // Late-arriving registry updates resolve lazily so a baked-lighting asset
  // saved after engine creation still applies on the next scene load.
  const assetRegistryRef = useRef(assetRegistry);
  assetRegistryRef.current = assetRegistry;
  const sceneAssetGuidRef = useRef<string | undefined>(undefined);
  sceneAssetGuidRef.current = doc?.ref.path
    ? assetRegistry?.list().find((asset) => asset.path === doc.ref.path)?.header.guid
    : undefined;
  const audioLibrary = useEditorAudioDebug(Boolean(scene?.actors.some((actor) =>
    selectedActorIds.includes(actor.id) &&
    actor.components.some((component) => component.classId === "AudioComponent"),
  )));
  const requestedRenderSettingsKey = sceneViewportRenderSettingsKey(
    projectDocument?.settings.render,
    scene?.settings.celShading,
    scene?.settings.shadowOverrides,
    scene?.settings.environmentLighting,
    scene?.settings.environmentTextureGuid,
  );
  const environmentSettingsKey = JSON.stringify(projectDocument?.settings.render.environmentLighting ?? {});
  const environmentSettingsRef = useRef(projectDocument?.settings.render.environmentLighting);
  environmentSettingsRef.current = projectDocument?.settings.render.environmentLighting;
  const [renderSettingsKey, setRenderSettingsKey] = useState(requestedRenderSettingsKey);
  // Shading changes replace compiled material ownership. Other rendering settings
  // are reconciled by the existing scene quality, lighting and material controllers.
  const renderMode = (JSON.parse(renderSettingsKey) as { mode: "pbr" | "cel" }).mode;
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

  const registerNavBakeCollector = navBake?.registerCollector;
  const registerSceneBakeCollector = sceneBake?.registerCollector;
  useEffect(() => {
    if (!registerSceneBakeCollector) return;
    if (!sceneReady || playing || preparing || !scene) {
      registerSceneBakeCollector(null);
      return;
    }
    registerSceneBakeCollector((source, owner) => {
      const handle = engineRef.current;
      const current = () => !!handle?.editor && !handle.scene.isDisposed && engineRef.current === handle &&
        sceneRef.current === source && handle.editor.sync.serializedScene() === source && !playingRef.current;
      if (!current()) throw new Error("Wait for the Scene viewport to finish loading before baking.");
      return { isCurrent: current, prepare: async (settings, signal) => {
        const { prepareSceneBake } = await import("@babylonslate/render/scene-bake-preparation");
        signal.throwIfAborted();
        const materials = await collectPlayMaterialLibrary(source);
        signal.throwIfAborted();
        if (!current()) throw new Error("The loaded Scene changed during Bake preparation.");
        return prepareSceneBake({ owner, current: () => current() ? owner : { ...owner, generation: owner.generation + 1 },
          document: source, settings, signal, materials: materials.documents,
          functions: Object.fromEntries(materials.functions),
          projectEnvironment: projectDocument?.settings.render.environmentLighting,
          meshForComponent: (actorId, componentId) => handle!.editor!.sync.meshForComponent(actorId, componentId),
        });
      } };
    });
    return () => registerSceneBakeCollector(null);
  }, [registerSceneBakeCollector, sceneReady, scene, playing, preparing, engineEpoch, collectPlayMaterialLibrary, projectDocument]);
  useEffect(() => {
    if (!registerNavBakeCollector) return;
    registerNavBakeCollector((extras) => {
      const handle = engineRef.current;
      const current = sceneRef.current;
      if (!handle?.editor || !current) {
        return { positions: [], indices: [] };
      }
      return collectNavBakeGeometry(handle.editor.sync, current, extras);
    });
    return () => registerNavBakeCollector(null);
  }, [registerNavBakeCollector]);

  useEffect(() => {
    const overlay = navDebugRef.current;
    const path =
      doc && isSceneWorkspaceKind(doc.ref.kind) ? doc.ref.path : null;
    const enabled = Boolean(
      scene && (navmeshVisible || navmeshOverlayEnabled(scene)),
    );
    if (!overlay || !enabled || !scene) {
      overlay?.clear();
      return;
    }
    const blockers = navDebugBlockersFromActors(scene.actors);
    let cancelled = false;
    void (async () => {
      const bytes =
        navBake?.lastBytes ??
        (path ? await readAssetChunk(path, NAVMESH_CHUNK_ID) : null);
      if (cancelled) return;
      await overlay.sync(bytes ?? null, blockers, scene.settings.physicsWorld);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    doc?.ref.kind,
    doc?.ref.path,
    navBake?.lastBytes,
    navOverlayGeneration,
    navmeshVisible,
    readAssetChunk,
    scene,
  ]);

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
  const commitGizmoTransformRef = useRef(commitGizmoTransform);
  commitGizmoTransformRef.current = commitGizmoTransform;

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

  useEffect(() => {
    setSharedEngine(ensureSharedEngine());
  }, [ensureSharedEngine, sharedEngineGeneration]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sharedEngine) return;
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

        const pipeline = registerScenePipelineStatus(scenePipelineKey(projectGuid, documentId));
        disposers.push(() => pipeline.dispose());
        const handle = createEngine(canvas, {
          editor: true,
          onRenderPathChanged: pipeline.publish,
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
          editorFlyEnabled: () => !playingRef.current,
          editorFlySpeed: () => flySpeedRef.current,
          bakeAssetReader: (guid, signal) => {
            const registry = assetRegistryRef.current;
            return registry
              ? bakeRuntimeAssetReader(registry)(guid, signal)
              : Promise.resolve(undefined);
          },
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
        setSceneLoad({ open: true, progress: 0, phase: "Realizing Scene", failed: true });
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
    // Mode, selection and tool changes are pushed by effects below.
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

  const materialLibraryKey = savedMaterialLibraryKey(
    assetRegistry?.list() ?? [],
  );
  const areaTextureGuids = useMemo(() => areaEmissionTextureGuids(scene), [scene]);
  const areaEmissionKey = savedAreaEmissionKey(areaTextureGuids, (guid) => assetRegistry?.getByGuid(guid));
  const textureLodKey = `${editorTextureLodEnabled}:${editorTextureLodQuality}`;

  useEffect(() => {
    const handle = engineRef.current;
    if (!scene || !handle) return;
    // Scene overrides arrive before the coalesced settings transaction. Do not
    // apply them through incremental loadScene while its blocking UI is pending.
    if (requestedRenderSettingsKey !== renderSettingsKey) return;
    setDropReady(null);
    setSceneReady(false);
    const controller = new AbortController();
    const transitionId = ++loadTransitionRef.current;
    const isCurrent = () => !controller.signal.aborted &&
      transitionId === loadTransitionRef.current && engineRef.current === handle;
    const generation = engineGenerationRef.current;
    const remount = isSceneViewportRemountLoad(
      generation,
      completedLoadGenerationRef.current,
    );
    const rendering = !remount && completedRenderSettingsRef.current !== renderSettingsKey;
    const blocking = remount || rendering;
    if (blocking) {
      blockingLoadRef.current = controller;
      handle.setPaused(true);
      setSceneLoad({ open: false, progress: 0, phase: "Preparing Scene", rendering });
    }
    void (async () => {
      let collected: EditorSceneLoadOptions | null = null;
      const realize = async () => {
        if (!isCurrent()) return;
        if (appliedRenderSettingsRef.current !== renderSettingsKey) {
          handle.setRenderSettings(sceneViewportRenderSettings(renderSettingsKey, environmentSettingsRef.current));
          appliedRenderSettingsRef.current = renderSettingsKey;
        }
        // Saved Material refreshes must not realize or re-dirty scene structure.
        if (blocking) {
          if (!collected) throw new Error("Scene assets were not collected before realization.");
          await handle.loadSceneAsync(scene, {
            ...collected,
            sceneAssetGuid: sceneAssetGuidRef.current,
          });
          if (!isCurrent()) return;
        } else {
          if (appliedSceneRef.current?.scene === scene && appliedSceneRef.current.handle === handle) return;
          handle.loadScene(scene, { sceneAssetGuid: sceneAssetGuidRef.current });
        }
        appliedSceneRef.current = { scene, handle };
      };
      const applyCollectedAssets = async () => {
        const sprites = await collectPlaySpritePayloads(scene);
        controller.signal.throwIfAborted();
        const tileContent = await collectPlayTilemapContent(scene);
        controller.signal.throwIfAborted();
        const modelBytes = await collectPlayModelBytes(scene);
        controller.signal.throwIfAborted();
        const modelPayloads = await collectPlayModelPayloads(scene);
        controller.signal.throwIfAborted();
        const materials = await collectPlayMaterialLibrary(
          scene,
          [],
          modelSlotMaterialGuidsFromPayloads(modelPayloads),
        );
        controller.signal.throwIfAborted();
        const extraTextureGuids = [
          ...environmentTextureGuidsFromScenes([scene]),
          ...postProcessTextureGuidsFromScenes([scene]),
          ...materials.textureGuids,
          ...skyboxFaceGuidsFromScene(scene),
          ...overlayTextureGuidsFromScene(scene),
        ];
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          extraTextureGuids,
        );
        controller.signal.throwIfAborted();
        const texturePixelSizes = collectPlayTexturePixelSizes(
          sprites,
          tileContent.tilesets,
          extraTextureGuids,
        );
        const fontFacetypeBytes = await collectPlayFontFacetypeBytes(scene);
        const areaEmissions = await collectPlayAreaEmissions([scene]);
        controller.signal.throwIfAborted();
        const msdf = fontMsdfMapsFromPairs(
          await collectPlayFontMsdfPair(scene),
        );
        controller.signal.throwIfAborted();
        const fontFaceEntries = await collectPlayFontFaceEntries();
        const fontCss = collectPlayFontCssStacks();
        if (!isCurrent()) return;
        await handle.registerFonts(fontFaceEntries);
        if (!isCurrent()) return;
        const assets = {
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          tilesets: tileContent.tilesets,
          textureBytes,
          texturePixelSizes,
          fontFacetypeBytes,
          areaEmissions,
          fontMsdfJson: msdf.json,
          fontMsdfPng: msdf.png,
          fontCssStack: fontCss.fontCssStack,
          fontCssStackByGuid: fontCss.fontCssStackByGuid,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
          sortingLayers: projectDocument?.settings.twoD.sortingLayers,
        };
        if (blocking) {
          collected = {
            signal: controller.signal,
            assets,
            materialDocuments: materials.documents,
            materialFunctions: materials.functions,
            onProgress: (progress) => {
              if (isCurrent()) setSceneLoad({ open: true, progress: 20 + 25 * progress, phase: "Realizing Scene", rendering });
            },
          };
        } else {
          handle.setMaterialDocuments(materials.documents, materials.functions);
          handle.setMeshAssets(assets);
        }
      };
      try {
        if (blocking) {
          const canvas = canvasRef.current;
          if (!canvas) return;
          await waitForCanvasSize(canvas, controller.signal);
          if (!isCurrent()) return;
          setSceneLoad({ open: true, progress: 0, phase: "Preparing Scene", rendering });
          await runSceneViewportBlockingLoad({
            signal: controller.signal,
            realize,
            collect: applyCollectedAssets,
            whenModelsReady: async () => {
              if (!isCurrent()) return;
              await handle.whenEditorModelsReady();
              if (!isCurrent()) return;
              await handle.whenMaterialTexturesReady();
            },
            warmShaders: async () => {
              if (!isCurrent()) return;
              await handle.prewarmSceneMaterials();
            },
            presentFirstFrame: async () => {
              if (!isCurrent()) return;
              await handle.presentFirstFrame();
            },
            onProgress: (progress, phase) => {
              if (!isCurrent()) return;
              setSceneLoad({ open: true, progress, phase, rendering });
            },
          });
        } else {
          await realize();
          await applyCollectedAssets();
          if (isCurrent()) {
            await handle.whenEditorModelsReady();
          }
        }
        if (isCurrent()) {
          setDropReady({ scene, handle });
          if (blocking) {
            completedLoadGenerationRef.current = generation;
            completedRenderSettingsRef.current = renderSettingsKey;
            setSceneLoad({
              open: false,
              progress: 100,
              phase: "Presenting First Frame",
              rendering,
            });
          }
          setSceneReady(true);
        }
      } catch (error) {
        if (!isCurrent()) return;
        console.error("[viewport] failed to load scene", error);
        releaseEngineRef.current?.();
        setSceneLoad((current) => ({ ...current, open: true, failed: true }));
      } finally {
        if (blockingLoadRef.current === controller) blockingLoadRef.current = null;
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    scene,
    requestedRenderSettingsKey,
    renderSettingsKey,
    materialLibraryKey,
    areaEmissionKey,
    textureLodKey,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayAreaEmissions,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument?.settings.twoD.pixelsPerUnit,
    projectDocument?.settings.twoD.sortingLayers,
    projectDocument?.settings.fonts.defaultFontGuid,
    projectDocument?.settings.fonts.globalFallback,
    engineEpoch,
  ]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    const byPath = new Map(
      (assetRegistry?.list({ type: "Material" }) ?? []).map((asset) => [
        asset.path,
        asset.header.guid,
      ]),
    );
    const guids = new Set<string>();
    for (const doc of openDocuments) {
      if (doc.ref.kind !== "material") continue;
      const guid = byPath.get(doc.ref.path);
      if (guid) guids.add(guid);
    }
    handle.setEditingMaterialGuids(guids);
  }, [openDocuments, assetRegistry, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setSelectedActors(selectedActorIds);
    engineRef.current?.editor?.syncSelectionDebug({
      sceneData: scene,
      selectedActorIds,
      audioLibrary,
    });
  }, [scene, selectedActorIds, engineEpoch, audioLibrary]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportShadingMode(viewportShadingMode);
  }, [viewportShadingMode, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setDrawMeshCollision(collisionsVisible);
  }, [collisionsVisible, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.setPreviewGameCamera(previewGameCamera);
  }, [previewGameCamera, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.camera.setPivotAroundCenter(pivotAroundCenter);
  }, [pivotAroundCenter, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool, engineEpoch]);

  useEffect(() => {
    const grid = scene?.settings.grid;
    engineRef.current?.editor?.gizmos.setSnap({
      enabled: snapEnabled,
      translate: grid?.snapTranslate ?? 1,
      rotateDeg: grid?.snapRotateDeg ?? 15,
      scale: grid?.snapScale ?? 0.25,
    });
  }, [scene?.settings.grid, snapEnabled, engineEpoch]);

  useEffect(() => {
    const settings = scene?.settings;
    if (!settings) return;
    engineRef.current?.editor?.setGridSettings({
      tileSize: settings.grid.tileSize,
      tileSubdivisions: settings.grid.tileSubdivisions,
      cameraBounds2D: settings.cameraBounds2D,
      showGrid: gridVisible,
    });
    // engineEpoch: the first scene payload often exists before createEngine.
    // Without it, this effect runs once with a null engineRef and never
    // reapplies cameraBounds2D (orange frame missing until Show Grid).
  }, [scene?.settings, viewportMode, gridVisible, engineEpoch]);

  useEffect(() => {
    engineRef.current?.editor?.grid.setVisible(gridVisible);
  }, [gridVisible, engineEpoch]);

  useEffect(() => {
    const twoD = projectDocument?.settings.twoD;
    const editor = engineRef.current?.editor;
    if (!editor || !twoD) return;
    editor.setSortingLayers(twoD.sortingLayers);
    editor.setPixelPerfect(
      viewportMode === "2d" && twoD.pixelPerfect
        ? {
            pixelsPerUnit: twoD.pixelsPerUnit,
            integerZoomSteps: twoD.integerZoomSteps,
          }
        : null,
    );
  }, [projectDocument?.settings.twoD, viewportMode, engineEpoch]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    type ViewportTestHost = {
      __babylonslateViewportTest?: {
        commitGizmoNudge: () => Promise<boolean>;
        commitMultiSelectGizmoNudge: () => Promise<boolean>;
        activeSceneMeshPosition: () => [number, number, number] | null;
        sceneTexturePixels: () => Promise<unknown>;
        sceneVisuals: () => Array<
          MaterialViewportTestSnapshot & {
            actorId: string;
            position: [number, number, number];
            materialName: string | null;
          }
        >;
        hardwareScalingLevel: () => number | null;
        postProcessPassCount: () => number | null;
        renderingBaseline: () => Record<string, unknown> | null;
        shadowDiagnostics: () => ReturnType<typeof captureShadowDiagnostics> | null;
        mannequinShadowProbe: (neutral: boolean, modelOnly?: boolean) => Promise<unknown>;
        setRenderSettings: EngineHandle["setRenderSettings"];
        setShadowCaptureView: (position: [number, number, number], target: [number, number, number], fov: number) => void;
        environmentTextureSamples: () => Promise<Record<string, unknown> | null>;
        environmentLightingProof: () => Promise<Record<string, unknown>>;
        measureRenderingBaseline: (durationMs: number) => Promise<Record<string, unknown>>;
        webgpuPreviewsProof: (
          options?: import("../testing/webgpu-previews-proof").ViewportProofOptions,
        ) => Promise<
          import("../testing/webgpu-previews-proof").ViewportProofResult
        >;
        engineSceneDiagnostics: () => Promise<
          import("../testing/webgpu-previews-proof").EngineSceneDiagnostics | null
        >;
      };
    };
    const host = globalThis as ViewportTestHost;
    let viewportFrameCap: number | null = null;
    const unsubscribeSettings = subscribeAppSettings(({ settings }) => {
      viewportFrameCap = settings.viewportFrameCap;
    });
    const measurements = new Set<() => void>();

      host.__babylonslateViewportTest = {
      environmentLightingProof: async () => {
        if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Environment proof requires a test build.");
        return (await import("../lib/environment-lighting-proof")).runEnvironmentLightingProof();
      },
      webgpuPreviewsProof: async (options) => {
        if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Preview proof requires a test build.");
        const handle = engineRef.current;
        const canvas = canvasRef.current;
        if (!handle || !canvas) throw new Error("No active viewport for the preview proof");
        return (await import("../testing/webgpu-previews-proof")).recordViewportProof(handle, canvas, options);
      },
      engineSceneDiagnostics: async () => {
        if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Scene diagnostics require a test build.");
        // Preview Scenes live on the shared Engine, which outlives viewport
        // remounts. While the Scene document tab is hidden the viewport handle
        // can be absent (waitForCanvasSize blocks the remount), so read the
        // session engine rather than engineRef.
        const engine = ensureSharedEngine();
        if (!engine) return null;
        return (await import("../testing/webgpu-previews-proof")).collectEngineSceneDiagnostics(engine, engineRef.current?.scene ?? null);
      },
      environmentTextureSamples: async () => {
        const handle = engineRef.current;
        const texture = handle?.scene.environmentTexture;
        if (!handle || !texture) return null;
        if (!texture.isReady()) return { ready: false, loadingError: texture.loadingError,
          error: texture.errorObject ? { message: texture.errorObject.message, exception: String(texture.errorObject.exception) } : null,
          size: texture.getSize(), isCube: texture.isCube };
        const size = texture.getSize();
        const lastMip = Math.floor(Math.log2(size.width));
        const samples = [];
        for (const face of [0, 5]) for (const level of [...new Set([0, lastMip])]) {
          const pixels = await texture.readPixels(face, level, undefined, true, false, 0, 0, 1, 1);
          samples.push({ face, level, type: pixels?.constructor.name, values: pixels ? Array.from(pixels as Uint8Array | Float32Array) : null });
        }
        return { size, isCube: texture.isCube, gammaSpace: texture.gammaSpace, samples,
          sceneConsumers: handle.engine.scenes.filter((scene) => scene.environmentTexture === texture).length,
          gpuType: texture.getInternalTexture()?.type };
      },
      measureRenderingBaseline: async (durationMs) => {
        for (const cancel of measurements) cancel();
        const handle = engineRef.current;
        if (!handle) throw new Error("No active viewport for rendering measurement");
        // Keep collection bounded even if a test supplies an invalid duration.
        const requestedMs = Number.isFinite(durationMs)
          ? Math.min(30_000, Math.max(1, durationMs)) : 30_000;
        return new Promise((resolve) => {
          const started = performance.now();
          const frameSamples: Array<{
            atMs: number; intervalMs: number | null; frameDelta: number;
            cpuMs: number; gpuMs: number | null; gpuStatus: string;
            viewportFrameCap: number | null; documentVisible: boolean;
          }> = [];
          const resourceSamples: Array<Record<string, number>> = [];
          let lastFrame = handle.scheduler.stats().renderedFrames;
          let lastPresented: number | null = null;
          let lastResourceAt = -250;
          let droppedSamples = 0;
          let finished = false;
          let previousTextures = new Set(handle.engine.getLoadedTexturesCache());
          let previousTargets = new Set(handle.engine._renderTargetWrapperCache);
          let texturesAdded = 0;
          let texturesRemoved = 0;
          let targetsAdded = 0;
          let targetsRemoved = 0;
          const sampleResources = (atMs: number) => {
            const textures = new Set(handle.engine.getLoadedTexturesCache());
            const targets = new Set(handle.engine._renderTargetWrapperCache);
            for (const texture of textures) if (!previousTextures.has(texture)) texturesAdded += 1;
            for (const texture of previousTextures) if (!textures.has(texture)) texturesRemoved += 1;
            for (const target of targets) if (!previousTargets.has(target)) targetsAdded += 1;
            for (const target of previousTargets) if (!targets.has(target)) targetsRemoved += 1;
            previousTextures = textures;
            previousTargets = targets;
            resourceSamples.push({
              atMs,
              estimatedTextureBytes: handle.resourceCache.accountedBytes(),
              estimatedGeometryBytes: handle.accountedGeometryBytes(),
              estimatedShadowBytes: handle.renderDiagnostics().shadowMapBytes,
              sceneMeshes: handle.scene.meshes.length,
              engineScenes: handle.engine.scenes.length,
              engineTextures: textures.size,
              engineRenderTargets: targets.size,
              texturesAdded, texturesRemoved, targetsAdded, targetsRemoved,
            });
            lastResourceAt = atMs;
          };
          const finish = (cancelled: string | null = null) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            handle.engine.onEndFrameObservable.remove(frameObserver);
            handle.engine.onContextLostObservable.remove(lostObserver);
            handle.scene.onDisposeObservable.remove(disposeObserver);
            measurements.delete(cancel);
            const elapsedMs = performance.now() - started;
            if (!cancelled) sampleResources(elapsedMs);
            resolve({ requestedMs, elapsedMs, cancelled, droppedSamples, frameSamples, resourceSamples });
          };
          const cancel = () => finish("Viewport measurement was superseded or disposed");
          const frameObserver = handle.engine.onEndFrameObservable.add(() => {
            if (engineRef.current !== handle || handle.scene.isDisposed) {
              cancel();
              return;
            }
            const frame = handle.scheduler.stats().renderedFrames;
            // Shared Engine end-frame notifications from sibling views are not
            // presentations of this viewport. Only its own scheduler advances.
            if (frame === lastFrame) return;
            const now = performance.now();
            const atMs = now - started;
            const diagnostics = handle.renderDiagnostics();
            if (frameSamples.length < 6_000) {
              frameSamples.push({
                atMs, intervalMs: lastPresented === null ? null : now - lastPresented,
                frameDelta: frame - lastFrame,
                cpuMs: diagnostics.cpuMs, gpuMs: diagnostics.gpuMs,
                gpuStatus: diagnostics.gpuStatus,
                viewportFrameCap, documentVisible: document.visibilityState === "visible",
              });
            } else droppedSamples += 1;
            lastFrame = frame;
            lastPresented = now;
            if (atMs - lastResourceAt >= 250) sampleResources(atMs);
          });
          const lostObserver = handle.engine.onContextLostObservable.add(() => finish("Rendering context was lost"));
          const disposeObserver = handle.scene.onDisposeObservable.addOnce(cancel);
          const timer = setTimeout(() => finish(), requestedMs);
          measurements.add(cancel);
          sampleResources(0);
        });
      },
      shadowDiagnostics: () => {
        const handle = engineRef.current;
        return handle ? captureShadowDiagnostics(handle.scene, { host: "editor", meshes: handle.scene.meshes }) : null;
      },
      mannequinShadowProbe: async (neutral, modelOnly) => {
        const handle = engineRef.current;
        if (!handle || import.meta.env.VITE_TEST_MODE !== "true") throw new Error("No test viewport");
        const result = (await import("../testing/mannequin-shadow-proof")).mannequinShadowProbe(handle.scene, neutral, modelOnly);
        handle.scheduler.invalidate("manual");
        return result;
      },
      setRenderSettings: (settings) => engineRef.current?.setRenderSettings(settings),
      setShadowCaptureView: (position, target, fov) => {
        const handle = engineRef.current;
        const camera = handle?.editor?.camera.camera;
        if (!handle || !camera) throw new Error("No editor camera for shadow capture");
        camera.setTarget(Vector3.FromArray(target));
        camera.setPosition(Vector3.FromArray(position));
        camera.fov = fov;
        camera.minZ = 0.1;
        camera.maxZ = 100;
        handle.scheduler.invalidate("camera");
      },
      renderingBaseline: () => {
        const handle = engineRef.current;
        if (!handle) return null;
        const caps = handle.engine.getCaps();
        return {
          userAgent: navigator.userAgent,
          backend: handle.engine.isWebGPU ? "webgpu" : "webgl2",
          engineCount: EngineStore.Instances.length,
          webGLVersion: "webGLVersion" in handle.engine ? handle.engine.webGLVersion : null,
          glInfo: "getGlInfo" in handle.engine && typeof handle.engine.getGlInfo === "function" ? handle.engine.getGlInfo() : null,
          gpuInfo: "getInfo" in handle.engine && typeof handle.engine.getInfo === "function" ? handle.engine.getInfo() : null,
          render: handle.renderDiagnostics(),
          frameCount: handle.scheduler.stats().renderedFrames,
          viewportFrameCap,
          drawCalls: handle.drawCalls(),
          liveObjects: handle.liveObjectCounts(),
          engineScenes: handle.engine.scenes.length,
          estimatedTextureBytes: handle.resourceCache.accountedBytes(),
          estimatedGeometryBytes: handle.accountedGeometryBytes(),
          ktx2Uploads: handle.engine.getLoadedTexturesCache()
            .filter((texture) => texture.isReady && texture._extension === ".ktx2")
            .map((texture) => ({ format: texture.format, type: texture.type, mips: texture.generateMipMaps })),
          sceneOverrides: sceneRef.current?.settings.shadowOverrides,
          capabilities: {
            maxTextureSize: caps.maxTextureSize,
            maxCubemapTextureSize: caps.maxCubemapTextureSize,
            maxTexturesImageUnits: caps.maxTexturesImageUnits,
            textureFloatRender: caps.textureFloatRender,
            textureHalfFloatRender: caps.textureHalfFloatRender,
            timerQuery: !!caps.timerQuery,
          },
        };
      },
      sceneTexturePixels: async () => {
        const sync = engineRef.current?.editor?.sync;
        if (!sync) return [];
        const samples = [];
        for (const actor of sceneRef.current?.actors ?? []) {
          const visual = sync.visualMeshesForActor(actor.id)[0];
          const texture = visual?.material?.getActiveTextures()[0];
          if (!texture || texture.isCube || !texture.isReady()) continue;
          const pixels = await texture.readPixels(0, 0, null, true, false, 0, 0, 1, 1);
          samples.push({ actorId: actor.id, name: texture.name, size: texture.getSize(),
            pixel: pixels ? Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)) : null });
        }
        return samples;
      },
      sceneVisuals: () => {
        const sync = engineRef.current?.editor?.sync;
        const actors = sceneRef.current?.actors ?? [];
        if (!sync) return [];
        return actors.flatMap((actor) => {
          const visual = sync.visualMeshesForActor(actor.id)[0];
          if (!visual) return [];
          visual.computeWorldMatrix(true);
          const position = visual.getAbsolutePosition();
          return [
            {
              ...materialViewportTestSnapshot(visual),
              actorId: actor.id,
              position: [position.x, position.y, position.z],
              materialName: visual.material?.name ?? null,
            },
          ];
        });
      },
      activeSceneMeshPosition: () => {
        const actorId = sceneRef.current?.actors[0]?.id;
        if (!actorId) return null;
        const mesh = engineRef.current?.editor?.sync.meshForActor(actorId);
        if (!mesh) return null;
        return [mesh.position.x, mesh.position.y, mesh.position.z];
      },
      hardwareScalingLevel: () => engineRef.current?.scaling.getLevel() ?? null,
      postProcessPassCount: () =>
        engineRef.current?.postProcessPassCount() ?? null,
      /**
       * Simulate a finished gizmo drag: mutate the live Babylon mesh, then
       * commit through the same path as onGizmoDragEnd (not a document-only nudge).
       */
      commitGizmoNudge: async () => {
        const handle = engineRef.current;
        const current = sceneRef.current;
        const actorId = current?.actors[0]?.id;
        if (!handle?.editor || !current || !actorId) return false;
        const mesh = handle.editor.sync.meshForActor(actorId);
        if (!mesh) return false;
        handle.editor.setSelectedActors([actorId]);
        mesh.position.x += 1.5;
        dragStartSceneRef.current = current;
        commitGizmoTransform();
        return true;
      },
      commitMultiSelectGizmoNudge: async () => {
        const handle = engineRef.current;
        const current = sceneRef.current;
        if (!handle?.editor || !current || current.actors.length < 2) {
          return false;
        }
        const ids = current.actors
          .filter((actor) => !actor.locked)
          .map((actor) => actor.id);
        handle.editor.setSelectedActors(ids);
        const attached = handle.editor.gizmos.attachedMesh();
        if (!attached) return false;
        const parentIdOf = (id: string) =>
          current.actors.find((actor) => actor.id === id)?.parentId ?? null;
        const followers = selectionGizmoRoots(ids, parentIdOf)
          .map((id) => handle.editor!.sync.meshForActor(id))
          .filter(
            (mesh): mesh is NonNullable<typeof mesh> =>
              mesh !== null && mesh !== attached,
          );
        const drag = beginGizmoMultiSelectDrag(attached, followers);
        attached.position.x += 1.5;
        if (drag) applyGizmoMultiSelectDrag(drag, attached);
        dragStartSceneRef.current = current;
        commitGizmoTransform();
        return true;
      },
    };

    return () => {
      for (const cancel of measurements) cancel();
      unsubscribeSettings();
      delete host.__babylonslateViewportTest;
    };
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
    let lastFrame = -1;
    let lastAt = -Infinity;
    const publish = () => {
      const frame = handle.scheduler.stats().renderedFrames;
      const now = performance.now();
      if (engineRef.current !== handle || handle.scene.isDisposed ||
        frame <= 0 || frame === lastFrame || now - lastAt < 250) return;
      const rect = canvas.getBoundingClientRect();
      panel.dataset.renderDiagnostics = JSON.stringify({
        frame, capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
        canvas: { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height },
        requested: JSON.parse(requestedRenderSettingsKey),
        render: handle.renderDiagnostics(),
      });
      lastFrame = frame;
      lastAt = now;
    };
    // sceneReady follows this view's presented first frame, not a sibling's
    // shared-Engine notification. Later captures require its own frame count.
    publish();
    const observer = handle.engine.onEndFrameObservable.add(publish);
    return () => {
      handle.engine.onEndFrameObservable.remove(observer);
      delete panel.dataset.renderDiagnostics;
    };
  }, [engineEpoch, sceneReady, sceneLoad.open, requestedRenderSettingsKey, renderSettingsKey]);

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
          className="pointer-events-auto rounded-lg border border-border bg-popover p-1 shadow-md"
          data-testid="viewport-panel-frame"
        >
          <ViewportToolbar
            onDrop={dropSelection}
            dropDisabled={dropDisabled}
            showViewportModeToggle={doc?.ref.kind !== "scene-layer"}
            showGizmoTools={!overlayTransformBox}
          />
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full min-h-0 min-w-0 w-full flex-1 touch-none"
        data-testid="viewport-canvas"
      />
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
        className="pointer-events-none absolute bottom-3 right-3 z-10 h-[180px] w-[320px] rounded-md border border-border bg-black"
      />
      {joystickEnabled ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-start p-4">
          <div className="pointer-events-auto">
            <ViewportJoystick
              speed={flySpeed}
              onFly={(forward, right) => {
                const camera = engineRef.current?.editor?.camera;
                if (camera) applyViewportJoystickSteer(camera, forward, right);
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
      />
    </div>
  );
}
