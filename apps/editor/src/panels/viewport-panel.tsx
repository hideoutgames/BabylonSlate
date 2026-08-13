import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ContextMenuOverlay,
  useContextMenu,
} from "@babylonslate/editor-kit";
import {
  createEngine,
  EDITOR_CANVAS_COLOR_SCHEME,
  syncEditorPlayState,
  type EngineHandle,
} from "@babylonslate/render";
import {
  engineCommandBus,
  findActor,
  type SerializedScene,
} from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { usePlay } from "../context/play-context";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";

function resizeCanvasIfSized(
  canvas: HTMLCanvasElement,
  handle: EngineHandle,
): void {
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    handle.resize();
  }
}

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
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
    collectPlayModelBytes,
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
    dragSelectActive,
    setDragSelectActive,
    setFrameActorHandler,
  } = useSceneEditing();
  const { registerSharedEngine, registerScheduler, playing } = usePlay();
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

  /** Turn the mesh state a gizmo drag left behind into one scene command. */
  const commitGizmoTransform = useCallback(() => {
    const handle = engineRef.current;
    const current = dragStartSceneRef.current ?? sceneRef.current;
    dragStartSceneRef.current = null;
    const live = handle?.editor?.attachedActorTransform();
    if (!handle || !current || !live) return;
    const actor = findActor(current, live.actorId);
    if (!actor) return;
    const next: SerializedScene = {
      ...current,
      actors: current.actors.map((entry) =>
        entry.id === live.actorId
          ? {
              ...entry,
              transform: {
                position: live.position,
                rotation: live.rotation,
                scale: live.scale,
              },
            }
          : entry,
      ),
    };
    void applySceneChange(documentId, next);
  }, [applySceneChange, documentId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = createEngine(canvas, {
      editor: true,
      viewportMode,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
      onPickActor: (actorId) => selectActorRef.current(actorId),
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
      onGizmoDragEnd: () => commitGizmoTransform(),
      editorFlyEnabled: () => !playingRef.current,
    });
    engineRef.current = handle;
    handle.editor?.setPreviewCanvas(previewCanvasRef.current);
    registerSharedEngine(handle.engine);
    const unregisterScheduler = registerScheduler({
      setAlwaysRender: (v) => handle.scheduler.setAlwaysRender(v),
      stats: () => handle.scheduler.stats(),
      setPaused: (v) => handle.setPaused(v),
    });
    const detachRenderGate = attachViewportRenderGate({
      canvas,
      scheduler: handle.scheduler,
    });

    const resizeIfSized = () => resizeCanvasIfSized(canvas, handle);
    resizeIfSized();

    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") {
        console.info("[Engine]", command.message);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      resizeIfSized();
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          resizeIfSized();
        }
      }
    });
    intersectionObserver.observe(canvas);

    handle.engine.onContextRestoredObservable.add(() => {
      resizeIfSized();
      const currentScene = sceneRef.current;
      if (currentScene) {
        handle.loadScene(currentScene);
      }
    });

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      detachRenderGate();
      unregisterScheduler();
      joystickLeaseRef.current?.();
      joystickLeaseRef.current = null;
      registerSharedEngine(null);
      handle.dispose();
      engineRef.current = null;
    };
    // The engine is created once per panel; mode, selection and tool changes
    // are pushed to it by the effects below rather than recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitGizmoTransform, registerSharedEngine, registerScheduler]);

  useEffect(() => {
    setFrameActorHandler((actorId) => {
      engineRef.current?.editor?.frameActor(actorId);
    });
    return () => setFrameActorHandler(null);
  }, [setFrameActorHandler]);

  useEffect(() => {
    if (engineRef.current) {
      syncEditorPlayState(engineRef.current, playing);
    }
  }, [playing]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!scene || !handle) return;
    handle.loadScene(scene);
    let cancelled = false;
    void (async () => {
      try {
        const sprites = await collectPlaySpritePayloads(scene);
        const tileContent = await collectPlayTilemapContent(scene);
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
        );
        const modelBytes = await collectPlayModelBytes(scene);
        if (cancelled || engineRef.current !== handle) return;
        handle.setMeshAssets({
          resourceCache: handle.resourceCache,
          spritePayloads: sprites,
          tilemaps: tileContent.tilemaps,
          tilesets: tileContent.tilesets,
          textureBytes,
          modelBytes,
          pixelsPerUnit: projectDocument?.settings.twoD.pixelsPerUnit,
        });
      } catch (error) {
        console.error("[viewport] failed to load mesh assets", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    scene,
    openDocuments,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayModelBytes,
    projectDocument?.settings.twoD.pixelsPerUnit,
  ]);

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
    });
  }, [scene?.settings, viewportMode]);

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
        activeSceneMeshPosition: () => [number, number, number] | null;
      };
    };
    const host = globalThis as ViewportTestHost;

    host.__babylonslateViewportTest = {
      activeSceneMeshPosition: () => {
        const actorId = sceneRef.current?.actors[0]?.id;
        if (!actorId) return null;
        const mesh = engineRef.current?.editor?.sync.meshForActor(actorId);
        if (!mesh) return null;
        return [mesh.position.x, mesh.position.y, mesh.position.z];
      },
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
    };

    return () => {
      delete host.__babylonslateViewportTest;
    };
  }, [commitGizmoTransform]);

  return (
    <div
      ref={panelRef}
      className="relative flex h-full w-full flex-col bg-background"
      data-testid="viewport-panel"
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
        className="h-full w-full flex-1 touch-none"
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
              onFly={(forward, right) => {
                engineRef.current?.editor?.camera.fly(forward, right);
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
    </div>
  );
}
