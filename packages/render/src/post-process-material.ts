import { Constants, type Camera, type PostProcess, type Scene } from "@babylonjs/core";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import { normalizeScenePostProcessStack } from "@babylonslate/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type {
  MaterialBuildPlan,
  MaterialDiagnostic,
  MaterialDocument,
} from "@babylonslate/shader-graph";
import { materialUnavailable, type MaterialLibrary } from "./material-library";
import { OwnedPostProcess } from "./owned-post-process";

/** One authored entry of a scene's ordered post-process chain. */
export interface PostProcessStackEntry {
  id?: string;
  materialGuid: string;
  enabled: boolean;
  order: number;
  scalable?: boolean;
  parameters?: Record<string, MaterialParameterValue>;
}

/** Scene documents omit `order`; normalize fills it from array index. */
export type PostProcessStackInput = {
  id?: string;
  materialGuid: string;
  enabled?: boolean;
  order?: number;
  scalable?: boolean;
  parameters?: Record<string, MaterialParameterValue>;
};

export function normalizePostProcessStack(
  value: unknown,
): PostProcessStackEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = value
    .flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const materialGuid = record.materialGuid;
      if (typeof materialGuid !== "string" || materialGuid === "") return [];
      return [
        {
          id: record.id,
          parameters: record.parameters,
          materialGuid,
          ...(record.scalable === true ? { scalable: true } : {}),
          enabled: record.enabled !== false,
          order:
            typeof record.order === "number" && Number.isFinite(record.order)
              ? record.order
              : index,
        },
      ];
    });
  const identities = normalizeScenePostProcessStack(entries);
  return entries.map((entry, index) => ({ ...entry, parameters: identities[index]!.parameters, id: identities[index]!.id }))
    .sort((a, b) => a.order - b.order);
}

export interface AttachedPostProcessStack {
  passes: PostProcess[];
  /** Updates only this live entry's instance, without recompiling its asset. */
  setParameter: (entryId: string, name: string, value: MaterialParameterValue) => boolean;
  getParameter: (entryId: string, name: string) => MaterialParameterValue | null;
  resetParameter: (entryId: string, name: string) => boolean;
  dispose: () => void;
  /** Bounded cleanup/reporting; rejection never grants permission to release sources. */
  whenDisposed: () => Promise<void>;
  /** Actual CPU/native reference release, independent of a GPU drain boundary. */
  whenReleased: () => Promise<void>;
}

let nextStackInstance = 0;

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
  resolutionScale?: number;
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
  const acquired = new Map<string, { materialGuid: string; instanceKey: string }>();
  const owned: Array<{ pass: OwnedPostProcess; instance: { materialGuid: string; instanceKey: string } }> = [];
  const retirements: Array<{ bounded: Promise<void>; released: Promise<void> }> = [];
  let signalDisposed!: () => void;
  const disposedSignal = new Promise<void>((resolve) => { signalDisposed = resolve; });
  const whenDisposed = disposedSignal.then(() => settleRetirements(retirements.map((entry) => entry.bounded)));
  const whenReleased = disposedSignal.then(() => settleRetirements(retirements.map((entry) => entry.released)));
  // Owners can opt into the reporting promise; retained references remain safe
  // even when a synchronous consumer only detaches the stack.
  void whenDisposed.catch(() => {});
  void whenReleased.catch(() => {});
  const retirePass = ({ pass, instance }: (typeof owned)[number]) => {
    let failure: unknown;
    try { pass.dispose(options.camera); } catch (error) { failure = error; }
    const bounded = failure === undefined ? pass.whenDisposed() : Promise.reject(failure);
    const release = () => options.library.release(options.scene, instance.materialGuid, instance);
    let released: Promise<void>;
    try {
      if (pass.isReleased) { release(); released = Promise.resolve(); }
      else released = pass.whenReleased().then(release);
    } catch (error) { released = Promise.reject(error); }
    void bounded.catch(() => {});
    void released.catch(() => {});
    retirements.push({ bounded, released });
  };
  const entries = normalizePostProcessStack(options.stack);
  const authoredParameters = new Map(entries.map((entry) => [entry.id, entry.parameters]));
  const stackInstance = nextStackInstance++;
  let depthHeld = false;
  let prePassHeld = false;
  const deviceBuffers =
    options.deviceBuffers ??
    probePostProcessDeviceBuffers(options.scene, options.camera);
  const hadDepth = Boolean(depthRendererFor(options.scene, options.camera));
  const hadPrePass = Boolean(options.scene.prePassRenderer);

  for (const entry of entries) {
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
    const instance = {
      materialGuid: entry.materialGuid,
      instanceKey: `post-process:${stackInstance}:${entry.id}`,
    };
    const compiled = options.library.acquire(
      options.scene,
      entry.materialGuid,
      document,
      {
        instanceKey: instance.instanceKey,
        validatePlan: (plan) => bufferDiagnostic(plan, deviceBuffers),
      },
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
    const needsDepth = compiled.plan.bufferRequirements.sceneDepth;
    for (const [name, value] of Object.entries(entry.parameters ?? {})) {
      if (!options.library.setParameter(options.scene, entry.materialGuid, name, value, instance))
        report(options, { materialGuid: entry.materialGuid, code: "material.parameter",
          message: `Post-process parameter "${name}" is unavailable or has an incompatible value` });
    }
    const needsNormal = compiled.plan.bufferRequirements.sceneNormal;
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
          nodeId: firstNodeId(compiled.plan, "input.sceneDepth"),
          materialGuid: entry.materialGuid,
          code: "material.capability",
        });
        options.library.release(options.scene, entry.materialGuid, instance);
        continue;
      }
    }
    if (needsNormal) {
      const renderer = options.scene.enablePrePassRenderer();
      if (!renderer) {
        report(options, {
          message: `Post-process material "${document.name}" needs Scene Normal, which this device cannot provide`,
          nodeId: firstNodeId(compiled.plan, "input.sceneNormal"),
          materialGuid: entry.materialGuid,
          code: "material.capability",
        });
        options.library.release(options.scene, entry.materialGuid, instance);
        continue;
      }
      if (!hadPrePass) prePassHeld = true;
    }
    let pass: OwnedPostProcess | undefined;
    try {
      pass = new OwnedPostProcess(`${compiled.material.name}PostProcess`, "postprocess", {
        camera: options.camera,
        engine: options.scene.getEngine(),
        size: entry.scalable ? (options.resolutionScale ?? 1) : 1,
        samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
        blockCompilation: true,
        shaderLanguage: compiled.material.shaderLanguage,
      });
      compiled.material.createEffectForPostProcess(pass);
      passes.push(pass);
      owned.push({ pass, instance });
      acquired.set(entry.id!, instance);
    } catch (error) {
      if (pass) retirePass({ pass, instance });
      else options.library.release(options.scene, entry.materialGuid, instance);
      report(options, { materialGuid: entry.materialGuid, code: "material.postProcess",
        message: `Post-process material "${document.name}" could not create its pass: ${String(error)}` });
    }
  }

  let disposed = false;
  return {
    passes,
    whenDisposed: () => whenDisposed,
    whenReleased: () => whenReleased,
    getParameter: (entryId, name) => {
      const instance = acquired.get(entryId);
      return !disposed && instance ? options.library.getParameter(
        options.scene, instance.materialGuid, name, instance,
      ) : null;
    },
    resetParameter: (entryId, name) => {
      const instance = acquired.get(entryId);
      if (disposed || !instance) return false;
      const authored = authoredParameters.get(entryId)?.[name];
      if (authored && options.library.setParameter(options.scene, instance.materialGuid, name, authored, instance)) return true;
      return options.library.resetParameter(options.scene, instance.materialGuid, name, instance);
    },
    setParameter: (entryId, name, value) => {
      const instance = acquired.get(entryId);
      return !disposed && !!instance && options.library.setParameter(
        options.scene, instance.materialGuid, name, value, instance,
      );
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const record of owned.splice(0)) retirePass(record);
      acquired.clear();
      authoredParameters.clear();
      passes.length = 0;
      try {
        // Passes cannot draw or bind again after logical detach. Release the
        // owned native renderer now so a replacement can acquire its own one.
        if (depthHeld) options.scene.disableDepthRenderer(options.camera);
        if (prePassHeld) options.scene.disablePrePassRenderer();
      } catch (error) {
        const failed = Promise.reject(error);
        void failed.catch(() => {});
        retirements.push({ bounded: failed, released: failed });
      }
      signalDisposed();
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
  const map = (scene as Scene & { _depthRenderer?: Record<number, unknown> })
    ._depthRenderer;
  return map?.[camera.uniqueId];
}

function report(
  options: AttachPostProcessStackOptions,
  diagnostic: PostProcessStackDiagnostic,
): void {
  options.onDiagnostic?.(diagnostic);
}

function firstNodeId(
  plan: MaterialBuildPlan,
  nodeType: string,
): string | undefined {
  return plan.operations.find((operation) => operation.nodeType === nodeType)
    ?.id;
}

function bufferDiagnostic(
  plan: MaterialBuildPlan,
  available: PostProcessDeviceBuffers,
): MaterialDiagnostic | undefined {
  for (const [buffer, title] of [
    ["sceneDepth", "Scene Depth"],
    ["sceneNormal", "Scene Normal"],
  ] as const) {
    if (plan.bufferRequirements[buffer] && !available[buffer])
      return {
        severity: "error",
        code: "material.capability",
        message: `Needs ${title}, which this device cannot provide`,
        nodeId: firstNodeId(plan, `input.${buffer}`),
      };
  }
  return undefined;
}

async function settleRetirements(pending: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(pending);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Post-process stack cleanup failed.");
}
