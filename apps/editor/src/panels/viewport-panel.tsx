import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import {
  ContextMenuOverlay,
  PanelFrame,
  useContextMenu,
} from "@babylonslate/editor-kit";
import { createEngine, type EngineHandle } from "@babylonslate/render";
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
  const engineRef = useRef<EngineHandle | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const dragStartSceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applySceneChange } = useDocuments();
  const {
    selectedActorIds,
    selectActor,
    gizmoTool,
    snapEnabled,
    viewportMode,
  } = useSceneEditing();
  const { registerSharedEngine, registerScheduler, playing } = usePlay();
  const selectActorRef = useRef(selectActor);
  selectActorRef.current = selectActor;

  const { menu, closeMenu, bind } = useContextMenu({
    items: [
      {
        id: "reload-scene",
        label: "Reload scene",
        onSelect: () => {
          const current = sceneRef.current;
          if (current && engineRef.current) {
            engineRef.current.loadScene(current);
          }
        },
      },
      {
        id: "frame-selection",
        label: "Frame selection",
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
      onPickActor: (actorId) => selectActorRef.current(actorId),
      onGizmoDragStart: () => {
        dragStartSceneRef.current = sceneRef.current;
      },
      onGizmoDragEnd: () => commitGizmoTransform(),
    });
    engineRef.current = handle;
    registerSharedEngine(handle.engine);
    registerScheduler({
      setAlwaysRender: (v) => handle.scheduler.setAlwaysRender(v),
      stats: () => handle.scheduler.stats(),
      setPaused: (v) => handle.setPaused(v),
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
      registerScheduler(null);
      registerSharedEngine(null);
      handle.dispose();
      engineRef.current = null;
    };
    // The engine is created once per panel; mode, selection and tool changes
    // are pushed to it by the effects below rather than recreating it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitGizmoTransform, registerSharedEngine, registerScheduler]);

  useEffect(() => {
    engineRef.current?.setPaused(playing);
  }, [playing]);

  useEffect(() => {
    if (scene && engineRef.current) {
      engineRef.current.loadScene(scene);
      engineRef.current.editor?.setSelectedActors(selectedActorIds);
    }
  }, [scene, selectedActorIds]);

  useEffect(() => {
    engineRef.current?.editor?.setSelectedActors(selectedActorIds);
  }, [selectedActorIds]);

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
      translate: grid?.snapTranslate ?? 1,
      rotateDeg: grid?.snapRotateDeg ?? 15,
      scale: grid?.snapScale ?? 0.25,
    });
  }, [scene?.settings.grid, snapEnabled]);

  return (
    <div
      ref={panelRef}
      className="relative flex h-full w-full flex-col bg-background"
      data-testid="viewport-panel"
      {...bind}
    >
      <PanelFrame
        title="Viewport"
        toolbar={<ViewportToolbar />}
        data-testid="viewport-panel-frame"
      >
        <canvas ref={canvasRef} className="h-full w-full touch-none" />
      </PanelFrame>
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
    </div>
  );
}
