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
import { useSceneEditing } from "../context/scene-editing-context";
import { attachViewportRenderGate } from "../lib/viewport-render-gate";
import { previewSceneFor } from "../lib/prefab-preview";

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
  const engineRef = useRef<EngineHandle | null>(null);
  const joystickLeaseRef = useRef<(() => void) | null>(null);
  const { components } = usePrefabEditing();
  const {
    gizmoTool,
    snapEnabled,
    viewportMode,
    selectedActorIds,
    joystickEnabled,
  } = useSceneEditing();
  const { registerScheduler, playing } = usePlay();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createEngine(canvas, {
      editor: true,
      viewportMode,
      colorScheme: EDITOR_CANVAS_COLOR_SCHEME,
    });
    engineRef.current = handle;
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
    const resizeObserver = new ResizeObserver(() => resizeIfSized());
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      detachRenderGate();
      unregisterScheduler();
      joystickLeaseRef.current?.();
      joystickLeaseRef.current = null;
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
    engineRef.current?.loadScene(previewSceneFor(components));
    engineRef.current?.resize();
  }, [components]);

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
    engineRef.current?.editor?.setSelectedActors(selectedActorIds);
  }, [selectedActorIds]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="prefab-viewport-panel"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-2">
        <div className="pointer-events-auto rounded-md border border-border bg-card/90 p-1">
          <ViewportToolbar testIdPrefix="prefab-" />
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-full min-h-0 w-full flex-1 touch-none"
        data-testid="prefab-preview-canvas"
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
    </div>
  );
}
