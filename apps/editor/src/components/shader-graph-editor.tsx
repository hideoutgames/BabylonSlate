import { useEffect, useRef } from "react";
import {
  compileShaderGraph,
  createDefaultShaderGraph,
  hydrateShaderGraphForEditor,
  serializedToShaderGraph,
  shaderGraphToSerialized,
  shaderPaletteNodes,
  validateShaderGraph,
  type ShaderGraphDocument,
} from "@babylonslate/shader-graph";
import {
  applyShaderGraphPreview,
  compileShaderGraphForRender,
  createEngine,
  type EngineHandle,
} from "@babylonslate/render";
import { GraphEditor } from "@babylonslate/graph-ui";

function asShaderGraph(payload: Record<string, unknown>): ShaderGraphDocument {
  return (payload as unknown as ShaderGraphDocument) ?? createDefaultShaderGraph();
}

function canHostWebGlPreview(canvas: HTMLCanvasElement): boolean {
  try {
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function ShaderGraphEditor({
  payload,
  onChange,
  enableLivePreview = true,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** WebGL NodeMaterial.Parse host. Off in jsdom; on in the editor / Playwright. */
  enableLivePreview?: boolean;
}) {
  const doc = asShaderGraph(payload);
  const compiled = compileShaderGraph(doc);
  const preview = compileShaderGraphForRender({ graph: doc });
  const diagnostics = validateShaderGraph(doc).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<EngineHandle | null>(null);
  const lastCompileAtRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enableLivePreview || !canvas || !canHostWebGlPreview(canvas)) return;
    let handle: EngineHandle | null = null;
    try {
      handle = createEngine(canvas, { playMode: true });
    } catch {
      return;
    }
    engineRef.current = handle;
    return () => {
      handle?.dispose();
      engineRef.current = null;
    };
  }, [enableLivePreview]);

  useEffect(() => {
    const handle = engineRef.current;
    if (!handle) return;
    let cancelled = false;
    const now = Date.now();
    void applyShaderGraphPreview({
      graph: doc,
      scene: handle.scene,
      lastCompileAt: lastCompileAtRef.current,
      now,
    }).then((result) => {
      if (cancelled) return;
      if (!result.skipped) lastCompileAtRef.current = now;
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="shader-graph-editor">
      <p className="px-3 py-1 text-xs text-muted-foreground">
        {compiled.ipadCostWarning
          ? "Post-process materials are expensive on iPad and off by default"
          : "Surface shader"}
      </p>
      <canvas
        ref={canvasRef}
        data-testid="shader-preview"
        data-compiled={preview.compiled ? "true" : "false"}
        data-skipped={preview.skipped ? "true" : "false"}
        data-post-process={compiled.postProcess ? "true" : "false"}
        className="h-32 w-full touch-none bg-background"
      />
      <GraphEditor
        initialGraph={hydrateShaderGraphForEditor(shaderGraphToSerialized(doc))}
        diagnostics={diagnostics}
        paletteNodes={shaderPaletteNodes()}
        onChange={(next) =>
          onChange(
            serializedToShaderGraph(next, doc) as unknown as Record<
              string,
              unknown
            >,
          )
        }
      />
    </div>
  );
}
