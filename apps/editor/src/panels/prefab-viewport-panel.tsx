import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import { createEngine, type EngineHandle } from "@babylonslate/render";
import { ViewportToolbar } from "../components/viewport-toolbar";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useSceneEditing } from "../context/scene-editing-context";
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
  const { components } = usePrefabEditing();
  const { gizmoTool, snapEnabled, viewportMode, selectedActorIds } =
    useSceneEditing();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createEngine(canvas, { editor: true, viewportMode });
    engineRef.current = handle;
    const resizeIfSized = () => resizeCanvasIfSized(canvas, handle);
    resizeIfSized();
    const resizeObserver = new ResizeObserver(() => resizeIfSized());
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      handle.dispose();
      engineRef.current = null;
    };
    // Engine is created once; mode/tool changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    </div>
  );
}
