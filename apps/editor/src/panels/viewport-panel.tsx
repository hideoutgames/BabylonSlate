import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef } from "react";
import {
  ContextMenuOverlay,
  useContextMenu,
} from "@babylonslate/editor-kit";
import { createEngine, type EngineHandle } from "@babylonslate/render";
import { engineCommandBus, type SerializedScene } from "@babylonslate/core";
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
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const sceneRef = useRef<SerializedScene | null>(null);
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();

  const { menu, closeMenu, bind } = useContextMenu(panelRef, {
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
    ],
  });

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
    <div
      ref={panelRef}
      className="relative h-full w-full bg-background"
      data-testid="viewport-panel"
      {...bind}
    >
      <canvas ref={canvasRef} className="h-full w-full touch-none" />
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
    </div>
  );
}
