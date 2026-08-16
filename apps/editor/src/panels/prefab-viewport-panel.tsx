import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import {
  createEngine,
  EDITOR_CANVAS_COLOR_SCHEME,
  syncEditorPlayState,
  type EngineHandle,
} from "@babylonslate/render";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { ViewportJoystick } from "../components/viewport-joystick";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { usePlay } from "../context/play-context";
import { useDocuments } from "../context/document-context";
import { useSceneEditing } from "../context/scene-editing-context";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import {
  previewSceneFor,
  PREFAB_ROOT_ID,
  prefabSelectedActorIds,
  prefabSelectedIdFromPick,
} from "../lib/prefab-preview";

function resizeCanvasIfSized(
  canvas: HTMLCanvasElement,
  handle: EngineHandle,
): void {
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    handle.resize();
  }
}

/**
 * Full-size Prefab viewport for class documents. Sibling of Graph in the
 * center Dockview group so selecting the tab fills the workspace.
 */
export function PrefabViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const joystickLeaseRef = useRef<(() => void) | null>(null);
  const {
    components,
    selectedId,
    setSelectedId,
    updateComponentTransform,
    applyPivotTransform,
  } = usePrefabEditing();
  const {
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayModelBytes,
    collectPlayMaterialLibrary,
    projectDocument,
  } = useDocuments();
  const {
    gizmoTool,
    snapEnabled,
    viewportMode,
    joystickEnabled,
    gridVisible,
    saveEditorCameraPose,
    loadEditorCameraPose,
  } = useSceneEditing();
  const { registerScheduler, playing } = usePlay();
  const setSelectedIdRef = useRef(setSelectedId);
  setSelectedIdRef.current = setSelectedId;
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const updateComponentTransformRef = useRef(updateComponentTransform);
  updateComponentTransformRef.current = updateComponentTransform;
  const applyPivotTransformRef = useRef(applyPivotTransform);
  applyPivotTransformRef.current = applyPivotTransform;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createEngine(canvas, {
      editor: true,
      viewportMode,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
      onPickActor: (actorId) => {
        const ids = new Set(componentsRef.current.map((component) => component.id));
        setSelectedIdRef.current(prefabSelectedIdFromPick(actorId, ids));
      },
      onGizmoDragEnd: () => {
        const live = engineRef.current?.editor?.attachedActorTransform();
        const selected = selectedIdRef.current;
        if (!live || !selected) return;
        const transform = {
          position: live.position,
          rotation: live.rotation,
          scale: live.scale,
        };
        if (selected === PREFAB_ROOT_ID) {
          applyPivotTransformRef.current(transform);
          return;
        }
        updateComponentTransformRef.current(selected, transform);
      },
    });
    engineRef.current = handle;
    handle.editor?.camera.importSessionState(loadEditorCameraPose());
    handle.editor?.setPreviewCanvas(previewCanvasRef.current);
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
    const resizeIfSized = () => resizeCanvasIfSized(canvas, handle);
    resizeIfSized();
    const resizeObserver = new ResizeObserver(() => resizeIfSized());
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      detachRenderGate();
      unregisterScheduler();
      joystickLeaseRef.current?.();
      joystickLeaseRef.current = null;
      if (handle.editor) {
        saveEditorCameraPose(handle.editor.camera.exportSessionState());
      }
      handle.dispose();
      engineRef.current = null;
    };
    // Engine is created once; mode/tool changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (engineRef.current) {
      syncEditorPlayState(engineRef.current, playing);
    }
  }, [playing]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    const scene = previewSceneFor(components);
    handle.loadScene(scene);
    handle.resize();
    let cancelled = false;
    void (async () => {
      try {
        const sprites = await collectPlaySpritePayloads(scene);
        const tileContent = await collectPlayTilemapContent(scene);
        const materials = await collectPlayMaterialLibrary(scene);
        const textureBytes = await collectPlayTextureBytes(
          sprites,
          tileContent.tilesets,
          materials.textureGuids,
        );
        const modelBytes = await collectPlayModelBytes(scene);
        if (cancelled || engineRef.current !== handle) return;
        handle.setMaterialDocuments(
          materials.documents,
          materials.functions,
        );
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
        console.error("[prefab] failed to load mesh assets", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    components,
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayModelBytes,
    collectPlayMaterialLibrary,
    projectDocument?.settings.twoD.pixelsPerUnit,
  ]);

  useEffect(() => {
    engineRef.current?.editor?.setViewportMode(viewportMode);
  }, [viewportMode]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setTool(gizmoTool);
  }, [gizmoTool]);

  useEffect(() => {
    engineRef.current?.editor?.gizmos.setSnap({
      enabled: snapEnabled,
      translate: 1,
      rotateDeg: 15,
      scale: 0.25,
    });
  }, [snapEnabled]);

  useEffect(() => {
    engineRef.current?.editor?.grid.setVisible(gridVisible);
  }, [gridVisible]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle?.editor) return;
    const selectedActors = prefabSelectedActorIds(selectedId);
    handle.editor.setSelectedActors(selectedActors);
    const scene = previewSceneFor(components);
    handle.editor.syncSelectionDebug({
      sceneData: scene,
      selectedActorIds: selectedActors,
      selectedComponentIds:
        selectedId && selectedId !== PREFAB_ROOT_ID ? [selectedId] : undefined,
    });
  }, [components, selectedId]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="prefab-viewport-panel"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div className="pointer-events-auto rounded-md border border-border bg-card/90 p-1">
          <ViewportToolbar testIdPrefix="prefab-" showDragSelect={false} />
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full min-h-0 w-full flex-1 touch-none"
        data-testid="prefab-preview-canvas"
      />
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
    </div>
  );
}
