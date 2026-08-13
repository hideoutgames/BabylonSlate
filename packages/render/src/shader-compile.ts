import type { ShaderCompileResult, ShaderGraphDocument } from "@babylonslate/shader-graph";
import {
  compileShaderGraph,
  shouldRecompilePreview,
} from "@babylonslate/shader-graph";

export interface NodeMaterialCompileRequest {
  graph: ShaderGraphDocument;
  /** When true, skip if last compile was too recent. */
  lastCompileAt?: number;
  now?: number;
  throttleMs?: number;
}

export interface NodeMaterialCompileResult extends ShaderCompileResult {
  compiled: boolean;
  skipped: boolean;
}

/**
 * Headless compile step. Render's live preview calls this, then
 * `NodeMaterial.Parse` / `forceCompilationAsync` on the main thread.
 */
export function compileShaderGraphForRender(
  request: NodeMaterialCompileRequest,
): NodeMaterialCompileResult {
  const now = request.now ?? 0;
  if (
    request.lastCompileAt !== undefined &&
    !shouldRecompilePreview(request.lastCompileAt, now, request.throttleMs)
  ) {
    return {
      fragmentOutputNodeId: null,
      postProcess: request.graph.postProcess,
      ipadCostWarning: request.graph.postProcess,
      sampledTextures: [],
      customBlocks: [],
      compiled: false,
      skipped: true,
    };
  }
  const compiled = compileShaderGraph(request.graph);
  return {
    ...compiled,
    compiled: true,
    skipped: false,
  };
}

/**
 * Load-time compile: never throttled. The Babylon host supplies
 * `forceCompilationAsync` (or a test double) after the IR is ready.
 */
export async function compileShaderGraphAtLoad(
  graph: ShaderGraphDocument,
  forceCompilationAsync: (
    ir: ShaderCompileResult,
  ) => Promise<void> = async () => {},
): Promise<NodeMaterialCompileResult> {
  const compiled = compileShaderGraph(graph);
  const result: NodeMaterialCompileResult = {
    ...compiled,
    compiled: true,
    skipped: false,
  };
  await forceCompilationAsync(compiled);
  return result;
}
