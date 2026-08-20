import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ContextMenuOverlay,
  useContextMenu,
} from "@babylonslate/editor-kit";
import {
  applyGizmoMultiSelectDrag,
  applyViewportJoystickSteer,
  beginGizmoMultiSelectDrag,
  collectNavBakeGeometry,
  createEngine,
  EDITOR_CANVAS_COLOR_SCHEME,
  NavMeshDebugOverlay,
  navDebugBlockersFromActors,
  navmeshOverlayEnabled,
  selectionGizmoRoots,
  syncEditorPlayState,
  type EngineHandle,
} from "@babylonslate/render";
import { NAVMESH_CHUNK_ID } from "@babylonslate/navigation";
import {
  engineCommandBus,
  type SerializedScene,
} from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import {
  FALLBACK_PLACE_POSITION,
  useSceneEditing,
} from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";
import { useOptionalNavBake } from "../context/nav-bake-context";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { SceneLoadingDialog } from "../components/scene-loading-dialog";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import { useEditorViewportPrefs } from "../lib/viewport-engine-prefs";
import { takeGizmoDragScene } from "../lib/gizmo-drag-commit";
import { editorKtx2PublicBase } from "../lib/public-engine-assets";
import { createCanvasResizeGuard } from "../lib/canvas-resize-guard";
import {
  modelSlotMaterialGuidsFromPayloads,
  skyboxFaceGuidsFromScene,
} from "../lib/play-content";
import {
  isSceneViewportRemountLoad,
  runSceneViewportBlockingLoad,
  type SceneViewportLoadPhase,
} from "../lib/scene-viewport-load";

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const navDebugRef = useRef<NavMeshDebugOverlay | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const dragStartSceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const {
    openDocuments,
    applySceneChange,
    projectDocument,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayFontFacetypeBytes,
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
  } = useSceneEditing();
  const { flySpeed } = useEditorViewportPrefs();
  const flySpeedRef = useRef(flySpeed);
  flySpeedRef.current = flySpeed;
  const { registerSharedEngine, registerScheduler, playing } = usePlay();
  const navBake = useOptionalNavBake();
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
  const [sceneLoad, setSceneLoad] = useState<{
    open: boolean;
    progress: number;
    phase: SceneViewportLoadPhase;
  }>({ open: false, progress: 0, phase: "Collecting Assets" });
  const [sceneReady, setSceneReady] = useState(false);

  const { menu, closeMenu, bind } = useContextMenu({
    items: [
      {
        id: "reload-scene",
        label: "Reload Scene",
        onSelect: () => {
          const current = sceneRef.current;
          if (current && engineRef.current) {
            engineRef.current.loadScene(current);
          }
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
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  const registerNavBakeCollector = navBake?.registerCollector;
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
    const path = doc?.ref.kind === "scene" ? doc.ref.path : null;
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
      await overlay.sync(bytes ?? null, blockers);
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
        return {
          ...entry,
          transform: {
            position: live.position,
            rotation: live.rotation,
            scale: live.scale,
          },
        };
      }),
    };
    void applySceneChange(documentId, next);
  }, [applySceneChange, documentId]);
  const commitGizmoTransformRef = useRef(commitGizmoTransform);
  commitGizmoTransformRef.current = commitGizmoTransform;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engineGenerationRef.current += 1;
    setSceneReady(false);

    const handle = createEngine(canvas, {
      editor: true,
      viewportMode,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
      ktx2BasePath: editorKtx2PublicBase(),
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
    });
    engineRef.current = handle;
    handle.editor?.camera.importSessionState(loadEditorCameraPose());
    navDebugRef.current = new NavMeshDebugOverlay(handle.scene);
    setNavOverlayGeneration((generation) => generation + 1);
    handle.editor?.setPreviewCanvas(previewCanvasRef.current);
    registerSharedEngine(handle.engine);
    const unregisterScheduler = registerScheduler({
      setAlwaysRender: (v) => handle.scheduler.setAlwaysRender(v),
      setPaused: (v) => handle.setPaused(v),
    });
    const detachRenderGate = attachViewportRenderGate({
      canvas,
      scheduler: handle.scheduler,
      scaling: handle.scaling,
      setPostProcessingEnabled: (enabled) =>
        handle.setPostProcessingEnabled(enabled),
    });

    const resizeIfSized = createCanvasResizeGuard(() => handle.resize(), {
      onHoldChange: (holding) => handle.scheduler.setResizing(holding),
    });
    resizeIfSized(canvas);

    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") {
        console.info("[Engine]", command.message);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      resizeIfSized(canvas);
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          resizeIfSized(canvas);
        }
      }
    });
    intersectionObserver.observe(canvas);

    handle.engine.onContextRestoredObservable.add(() => {
      resizeIfSized(canvas);
      const currentScene = sceneRef.current;
      if (currentScene) {
        handle.loadScene(currentScene);
      }
    });

    return () => {
      unsubscribe();
      resizeIfSized.dispose();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      detachRenderGate();
      unregisterScheduler();
      joystickLeaseRef.current?.();
      joystickLeaseRef.current = null;
      registerSharedEngine(null);
      navDebugRef.current?.dispose();
      navDebugRef.current = null;
      if (handle.editor) {
        saveEditorCameraPose(handle.editor.camera.exportSessionState());
      }
      handle.dispose();
      engineRef.current = null;
    };
    // The engine is created once per panel; mode, selection and tool changes
    // are pushed to it by the effects below rather than recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSharedEngine, registerScheduler]);

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
      syncEditorPlayState(engineRef.current, playing);
    }
  }, [playing]);

  // Key on the scene payload, not `openDocuments` array identity. Save All
  // calls bump() after markAllClean; a new array would reload the viewport
  // and can race the write or re-dirty the scene.
  useEffect(() => {
    const handle = engineRef.current;
    if (!scene || !handle) return;
    handle.loadScene(scene);
    let cancelled = false;
    const generation = engineGenerationRef.current;
    const blocking = isSceneViewportRemountLoad(
      generation,
      completedLoadGenerationRef.current,
    );
    if (blocking) {
      setSceneLoad({ open: true, progress: 0, phase: "Collecting Assets" });
    }
    void (async () => {
      const applyCollectedAssets = async () => {
        const sprites = await collectPlaySpritePayloads(scene);
        const tileContent = await collectPlayTilemapContent(scene);
        const modelBytes = await collectPlayModelBytes(scene);
        const modelPayloads = await collectPlayModelPayloads(scene);
        const materials = await collectPlayMaterialLibrary(
          scene,
          [],
          modelSlotMaterialGuidsFromPayloads(modelPayloads),
        );
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          [...materials.textureGuids, ...skyboxFaceGuidsFromScene(scene)],
        );
        const fontFacetypeBytes = await collectPlayFontFacetypeBytes(scene);
        if (cancelled || engineRef.current !== handle) return;
        handle.setMaterialDocuments(materials.documents, materials.functions);
        handle.setMeshAssets({
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          tilesets: tileContent.tilesets,
          textureBytes,
          fontFacetypeBytes,
          modelBytes,
          modelPayloads,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
      };
      try {
        if (blocking) {
          await runSceneViewportBlockingLoad({
            collect: applyCollectedAssets,
            whenModelsReady: async () => {
              if (cancelled || engineRef.current !== handle) return;
              await handle.whenEditorModelsReady();
            },
            warmShaders: async () => {
              if (cancelled || engineRef.current !== handle) return;
              await handle.prewarmSceneMaterials();
            },
            onProgress: (progress, phase) => {
              if (cancelled) return;
              setSceneLoad({ open: true, progress, phase });
            },
          });
        } else {
          await applyCollectedAssets();
        }
      } catch (error) {
        console.error("[viewport] failed to load mesh assets", error);
      } finally {
        if (!cancelled && blocking) {
          completedLoadGenerationRef.current = generation;
          setSceneLoad({
            open: false,
            progress: 100,
            phase: "Warming Shaders",
          });
          setSceneReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    scene,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayFontFacetypeBytes,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument?.settings.twoD.pixelsPerUnit,
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
  }, [openDocuments, assetRegistry]);

  useEffect(() => {
    engineRef.current?.editor?.setSelectedActors(selectedActorIds);
    engineRef.current?.editor?.syncSelectionDebug({
      sceneData: scene,
      selectedActorIds,
    });
  }, [scene, selectedActorIds]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportShadingMode(viewportShadingMode);
  }, [viewportShadingMode]);

  useEffect(() => {
    engineRef.current?.editor?.setPreviewGameCamera(previewGameCamera);
  }, [previewGameCamera]);

  useEffect(() => {
    engineRef.current?.editor?.camera.setPivotAroundCenter(pivotAroundCenter);
  }, [pivotAroundCenter]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool]);

  useEffect(() => {
    const grid = scene?.settings.grid;
    engineRef.current?.editor?.gizmos.setSnap({
      enabled: snapEnabled,
      // 2D translation snaps to the tile the grid actually draws, so dragging
      // with snap on lands sprites on tile boundaries.
      translate:
        viewportMode === "2d"
          ? (grid?.tileSize ?? 1)
          : (grid?.snapTranslate ?? 1),
      rotateDeg: grid?.snapRotateDeg ?? 15,
      scale: grid?.snapScale ?? 0.25,
    });
  }, [scene?.settings.grid, snapEnabled, viewportMode]);

  useEffect(() => {
    const settings = scene?.settings;
    if (!settings) return;
    engineRef.current?.editor?.setGridSettings({
      tileSize: settings.grid.tileSize,
      tileSubdivisions: settings.grid.tileSubdivisions,
      cameraBounds2D: settings.cameraBounds2D,
      showGrid: gridVisible,
    });
  }, [scene?.settings, viewportMode, gridVisible]);

  useEffect(() => {
    engineRef.current?.editor?.grid.setVisible(gridVisible);
  }, [gridVisible]);

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
  }, [projectDocument?.settings.twoD, viewportMode]);

  useEffect(() => {
    if (!isTestModeEnabled()) return;
    type ViewportTestHost = {
      __babylonslateViewportTest?: {
        commitGizmoNudge: () => Promise<boolean>;
        commitMultiSelectGizmoNudge: () => Promise<boolean>;
        activeSceneMeshPosition: () => [number, number, number] | null;
        sceneVisuals: () => Array<{
          actorId: string;
          position: [number, number, number];
          materialName: string | null;
        }>;
        hardwareScalingLevel: () => number | null;
        postProcessPassCount: () => number | null;
      };
    };
    const host = globalThis as ViewportTestHost;

    host.__babylonslateViewportTest = {
      sceneVisuals: () => {
        const sync = engineRef.current?.editor?.sync;
        const actors = sceneRef.current?.actors ?? [];
        if (!sync) return [];
        return actors.flatMap((actor) => {
          const visual = sync.visualMeshesForActor(actor.id)[0];
          if (!visual) return [];
          visual.computeWorldMatrix(true);
          const position = visual.getAbsolutePosition();
          return [{
            actorId: actor.id,
            position: [position.x, position.y, position.z],
            materialName: visual.material?.name ?? null,
          }];
        });
      },
      activeSceneMeshPosition: () => {
        const actorId = sceneRef.current?.actors[0]?.id;
        if (!actorId) return null;
        const mesh = engineRef.current?.editor?.sync.meshForActor(actorId);
        if (!mesh) return null;
        return [mesh.position.x, mesh.position.y, mesh.position.z];
      },
      hardwareScalingLevel: () =>
        engineRef.current?.scaling.getLevel() ?? null,
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
      delete host.__babylonslateViewportTest;
    };
  }, [commitGizmoTransform]);

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col bg-background"
      data-testid="viewport-panel"
      data-scene-ready={sceneReady ? "true" : "false"}
      {...bind}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div
          className="pointer-events-auto rounded-lg border border-border bg-popover p-1 shadow-md"
          data-testid="viewport-panel-frame"
        >
          <ViewportToolbar />
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
                  joystickLeaseRef.current ??= scheduler.acquireContinuous(
                    "viewport-joystick",
                  );
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
      />
    </div>
  );
}
