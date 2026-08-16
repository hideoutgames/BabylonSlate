import type { Camera, NodeMaterial, PostProcess, Scene } from "@babylonjs/core";
import type { MaterialDocument } from "@babylonslate/shader-graph";
import { materialUnavailable, type MaterialLibrary } from "./material-library";

/** One authored entry of a scene's ordered post-process chain. */
export interface PostProcessStackEntry {
  materialGuid: string;
  enabled: boolean;
  order: number;
}

export function normalizePostProcessStack(
  value: unknown,
): PostProcessStackEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const materialGuid = record.materialGuid;
      if (typeof materialGuid !== "string" || materialGuid === "") return [];
      return [
        {
          materialGuid,
          enabled: record.enabled !== false,
          order:
            typeof record.order === "number" && Number.isFinite(record.order)
              ? record.order
              : index,
        },
      ];
    })
    .sort((a, b) => a.order - b.order);
}

export interface AttachedPostProcessStack {
  passes: PostProcess[];
  dispose: () => void;
}

export interface AttachPostProcessStackOptions {
  scene: Scene;
  camera: Camera;
  library: MaterialLibrary;
  stack: readonly PostProcessStackEntry[];
  documentFor: (materialGuid: string) => MaterialDocument | null;
  onDiagnostic?: (message: string) => void;
}

/**
 * Compile and attach a scene's post-process materials to one camera, in the
 * authored order. Disabled entries and entries whose material fails to compile
 * are skipped so one broken pass cannot black out the frame.
 */
export function attachPostProcessStack(
  options: AttachPostProcessStackOptions,
): AttachedPostProcessStack {
  const passes: PostProcess[] = [];
  const acquired: string[] = [];

  for (const entry of [...options.stack].sort((a, b) => a.order - b.order)) {
    if (!entry.enabled) continue;
    const document = options.documentFor(entry.materialGuid);
    if (!document) {
      options.onDiagnostic?.(
        `Post-process material "${entry.materialGuid}" is not in this project`,
      );
      continue;
    }
    if (document.domain !== "postProcess") {
      options.onDiagnostic?.(
        `Material "${document.name}" is a surface material and cannot run as a post-process pass`,
      );
      continue;
    }
    const compiled = options.library.acquire(
      options.scene,
      entry.materialGuid,
      document,
    );
    if (materialUnavailable(compiled)) {
      options.onDiagnostic?.(
        `Post-process material "${document.name}" failed to compile: ${
          compiled.diagnostics[0]?.message ?? "unknown error"
        }`,
      );
      continue;
    }
    acquired.push(entry.materialGuid);
    const pass = createPostProcessPass(compiled.material, options.camera);
    if (pass) passes.push(pass);
  }

  let disposed = false;
  return {
    passes,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const pass of passes) pass.dispose(options.camera);
      for (const guid of acquired) options.library.release(options.scene, guid);
      passes.length = 0;
    },
  };
}

function createPostProcessPass(
  material: NodeMaterial,
  camera: Camera,
): PostProcess | null {
  return material.createPostProcess(camera) ?? null;
}
