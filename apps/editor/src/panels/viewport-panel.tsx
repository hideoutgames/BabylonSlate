import type { IDockviewPanelProps } from "dockview";
import { useEffect, useRef } from "react";
import { createEngine, type EngineHandle } from "@babylonslate/engine";
import { engineCommandBus, type SerializedScene } from "@babylonslate/shared";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = createEngine(canvas);
    engineRef.current = handle;

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
      handle.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (scene && engineRef.current) {
      engineRef.current.loadScene(scene);
    }
  }, [scene]);

  return (
    <div className="h-full w-full bg-background">
      <canvas ref={canvasRef} className="h-full w-full touch-none" />
    </div>
  );
}
