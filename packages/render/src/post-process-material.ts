import type { Camera, NodeMaterial, PostProcess, Scene } from "@babylonjs/core";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import {
  lowerMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { materialUnavailable, type MaterialLibrary } from "./material-library";

/** One authored entry of a scene's ordered post-process chain. */
export interface PostProcessStackEntry {
  materialGuid: string;
  enabled: boolean;
  order: number;
}

/** Scene documents omit `order`; normalize fills it from array index. */
export type PostProcessStackInput = {
  materialGuid: string;
  enabled?: boolean;
  order?: number;
};

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

export interface PostProcessDeviceBuffers {
  sceneDepth: boolean;
  sceneNormal: boolean;
}

export interface PostProcessStackDiagnostic {
  message: string;
  nodeId?: string;
  materialGuid?: string;
  code?: string;
}

export interface AttachPostProcessStackOptions {
  scene: Scene;
  camera: Camera;
  library: MaterialLibrary;
  stack: readonly PostProcessStackEntry[];
  documentFor: (materialGuid: string) => MaterialDocument | null;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
  /** When a buffer is explicitly false, skip passes that sample it. */
  deviceBuffers?: PostProcessDeviceBuffers;
}

/**
 * Probe whether this scene can provide Scene Depth / Scene Normal.
 * Depth is a camera depth renderer (linear). Normals need a pre-pass MRT,
 * which returns null on devices that cannot allocate it.
 *
 * The probe never disposes a depth or pre-pass renderer another subsystem
 * already owns. Temporary probe allocations are released before return.
 */
export function probePostProcessDeviceBuffers(
  scene: Scene,
  camera: Camera | null,
): PostProcessDeviceBuffers {
  if (!camera) return { sceneDepth: false, sceneNormal: false };
  return {
    sceneDepth: probeSceneDepth(scene, camera),
    sceneNormal: probeSceneNormal(scene),
  };
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
  let depthHeld = false;
  let prePassHeld = false;
  const deviceBuffers =
    options.deviceBuffers ??
    probePostProcessDeviceBuffers(options.scene, options.camera);
  const hadDepth = Boolean(depthRendererFor(options.scene, options.camera));
  const hadPrePass = Boolean(options.scene.prePassRenderer);

  for (const entry of [...options.stack].sort((a, b) => a.order - b.order)) {
    if (!entry.enabled) continue;
    const document = options.documentFor(entry.materialGuid);
    if (!document) {
      report(options, {
        message: `Post-process material "${entry.materialGuid}" is not in this project`,
        materialGuid: entry.materialGuid,
      });
      continue;
    }
    if (document.domain !== "postProcess") {
      report(options, {
        message: `Material "${document.name}" is a surface material and cannot run as a post-process pass`,
        materialGuid: entry.materialGuid,
      });
      continue;
    }
    const lowered = lowerMaterialDocument(document);
    if (
      lowered.ok &&
      bufferDenied(
        lowered.plan.bufferRequirements.sceneDepth,
        deviceBuffers.sceneDepth,
      )
    ) {
      report(options, {
        message: `Post-process material "${document.name}" needs Scene Depth, which this device cannot provide`,
        nodeId: firstNodeId(document, "input.sceneDepth"),
        materialGuid: entry.materialGuid,
        code: "material.capability",
      });
      continue;
    }
    if (
      lowered.ok &&
      bufferDenied(
        lowered.plan.bufferRequirements.sceneNormal,
        deviceBuffers.sceneNormal,
      )
    ) {
      report(options, {
        message: `Post-process material "${document.name}" needs Scene Normal, which this device cannot provide`,
        nodeId: firstNodeId(document, "input.sceneNormal"),
        materialGuid: entry.materialGuid,
        code: "material.capability",
      });
      continue;
    }
    const compiled = options.library.acquire(
      options.scene,
      entry.materialGuid,
      document,
    );
    if (materialUnavailable(compiled)) {
      report(options, {
        message: `Post-process material "${document.name}" failed to compile: ${
          compiled.diagnostics[0]?.message ?? "unknown error"
        }`,
        nodeId: compiled.diagnostics[0]?.nodeId,
        materialGuid: entry.materialGuid,
        code: compiled.diagnostics[0]?.code,
      });
      continue;
    }
    const needsDepth =
      lowered.ok &&
      lowered.plan.bufferRequirements.sceneDepth &&
      deviceBuffers.sceneDepth;
    const needsNormal =
      lowered.ok &&
      lowered.plan.bufferRequirements.sceneNormal &&
      deviceBuffers.sceneNormal;
    if (needsDepth) {
      try {
        options.scene.enableDepthRenderer(
          options.camera,
          false,
          false,
          undefined,
          false,
        );
        if (!hadDepth) depthHeld = true;
      } catch {
        report(options, {
          message: `Post-process material "${document.name}" needs Scene Depth, which this device cannot provide`,
          nodeId: firstNodeId(document, "input.sceneDepth"),
          materialGuid: entry.materialGuid,
          code: "material.capability",
        });
        options.library.release(options.scene, entry.materialGuid);
        continue;
      }
    }
    if (needsNormal) {
      const renderer = options.scene.enablePrePassRenderer();
      if (!renderer) {
        report(options, {
          message: `Post-process material "${document.name}" needs Scene Normal, which this device cannot provide`,
          nodeId: firstNodeId(document, "input.sceneNormal"),
          materialGuid: entry.materialGuid,
          code: "material.capability",
        });
        options.library.release(options.scene, entry.materialGuid);
        continue;
      }
      if (!hadPrePass) prePassHeld = true;
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
      if (depthHeld) options.scene.disableDepthRenderer(options.camera);
      if (prePassHeld) options.scene.disablePrePassRenderer();
      passes.length = 0;
    },
  };
}

function probeSceneDepth(scene: Scene, camera: Camera): boolean {
  if (depthRendererFor(scene, camera)) return true;
  try {
    const renderer = scene.enableDepthRenderer(
      camera,
      false,
      false,
      undefined,
      false,
    );
    if (!renderer) return false;
    scene.disableDepthRenderer(camera);
    return true;
  } catch {
    return false;
  }
}

function probeSceneNormal(scene: Scene): boolean {
  if (scene.prePassRenderer) return true;
  try {
    const prePass = scene.enablePrePassRenderer();
    if (!prePass) return false;
    scene.disablePrePassRenderer();
    return true;
  } catch {
    return false;
  }
}

function depthRendererFor(scene: Scene, camera: Camera): unknown {
  const map = (
    scene as Scene & { _depthRenderer?: Record<number, unknown> }
  )._depthRenderer;
  return map?.[camera.uniqueId];
}

function report(
  options: AttachPostProcessStackOptions,
  diagnostic: PostProcessStackDiagnostic,
): void {
  options.onDiagnostic?.(diagnostic);
}

function firstNodeId(
  document: MaterialDocument,
  nodeType: string,
): string | undefined {
  return document.nodes.find((node) => node.type === nodeType)?.id;
}

function bufferDenied(needed: boolean, available: boolean): boolean {
  return needed && !available;
}

function createPostProcessPass(
  material: NodeMaterial,
  camera: Camera,
): PostProcess | null {
  return material.createPostProcess(camera) ?? null;
}
