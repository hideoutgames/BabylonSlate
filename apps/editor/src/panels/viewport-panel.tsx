import type { IDockviewPanelProps } from "dockview";
import { useEffect, useRef } from "react";
import { createEngine, type EngineHandle } from "@babylonslate/engine";
import { engineCommandBus } from "@babylonslate/shared";
import { useProject } from "../context/project-context";

export function ViewportPanel(_props: IDockviewPanelProps) {
  void _props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const { projectState } = useProject();

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
    if (projectState?.scene && engineRef.current) {
      engineRef.current.loadScene(projectState.scene);
    }
  }, [projectState?.scene]);

  return (
    <div className="h-full w-full bg-background">
      <canvas ref={canvasRef} className="h-full w-full touch-none" />
    </div>
  );
}
