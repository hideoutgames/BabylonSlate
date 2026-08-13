import { NodeMaterial, type Scene } from "@babylonjs/core";
import type {
  ShaderCompileResult,
  ShaderGraphDocument,
} from "@babylonslate/shader-graph";
import {
  compileShaderGraphForRender,
  type NodeMaterialCompileResult,
} from "./shader-compile";

export type ParseNodeMaterial = (
  source: unknown,
  scene: Scene,
) => NodeMaterial;

export interface ApplyShaderGraphPreviewRequest {
  graph: ShaderGraphDocument;
  scene: Scene;
  lastCompileAt?: number;
  now?: number;
  throttleMs?: number;
  parse?: ParseNodeMaterial;
  forceCompilationAsync?: (
    material: NodeMaterial,
    ir: ShaderCompileResult,
  ) => Promise<void>;
}

export interface ShaderGraphPreviewResult extends NodeMaterialCompileResult {
  parsed: boolean;
  material: NodeMaterial | null;
}

/**
 * Default surface / post-process NodeMaterial JSON for Parse.
 * Does not rewrite shader-graph IR — compile still returns metadata only.
 */
export function shaderPreviewNodeMaterialSource(
  ir: ShaderCompileResult,
  scene: Scene,
): unknown {
  const scratch = new NodeMaterial("shader-preview-template", scene);
  if (ir.postProcess) {
    scratch.setToDefaultPostProcess();
  } else {
    scratch.setToDefault();
  }
  const json = scratch.serialize() as Record<string, unknown>;
  scratch.dispose();
  json.comment = ir.fragmentOutputNodeId ?? "";
  return json;
}

/**
 * Throttled live-preview bind: compile IR, then `NodeMaterial.Parse`
 * (or an injected parser). `forceCompilationAsync` is injected so NullEngine
 * tests skip the WebGL compile.
 */
export async function applyShaderGraphPreview(
  request: ApplyShaderGraphPreviewRequest,
): Promise<ShaderGraphPreviewResult> {
  const compiled = compileShaderGraphForRender({
    graph: request.graph,
    lastCompileAt: request.lastCompileAt,
    now: request.now,
    throttleMs: request.throttleMs,
  });
  if (compiled.skipped) {
    return { ...compiled, parsed: false, material: null };
  }
  const source = shaderPreviewNodeMaterialSource(compiled, request.scene);
  const parse =
    request.parse ?? ((json, scene) => NodeMaterial.Parse(json, scene));
  const material = parse(source, request.scene);
  material.name = "shader-preview";
  if (request.forceCompilationAsync) {
    await request.forceCompilationAsync(material, compiled);
  }
  return { ...compiled, parsed: true, material };
}
