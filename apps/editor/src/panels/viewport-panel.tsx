import type { IDockviewPanelProps } from "dockview";
import { useEffect, useRef } from "react";
import { createEngine, type EngineHandle } from "@babylonslate/engine";
import { engineCommandBus, type SerializedScene } from "@babylonslate/shared";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const scene =
    doc?.ref.kind === "scene" ? (doc.content as SerializedScene) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = createEngine(canvas);
    engineRef.current = handle;

    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type === "log") {
        console.info("[Engine]", command.message);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      handle.resize();
    });
    resizeObserver.observe(canvas);

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
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
