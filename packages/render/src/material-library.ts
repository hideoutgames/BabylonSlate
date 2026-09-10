import type { Mesh, NodeMaterial, Scene, Texture } from "@babylonjs/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import {
  lowerMaterialDocument,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { validMaterialParameterValue } from "./material-parameters";
import { applyMaterialBounds } from "./material-bounds";
import {
  compileMaterialPlan,
  materialCompileFailed,
  prewarmMaterial,
} from "./material-compiler";

export interface AcquiredMaterial {
  ok: true;
  material: NodeMaterial;
  hash: string;
  ready: Promise<readonly MaterialDiagnostic[]>;
}

export interface UnavailableMaterial {
  ok: false;
  diagnostics: MaterialDiagnostic[];
}

export type MaterialAcquireResult = AcquiredMaterial | UnavailableMaterial;

/** See `materialCompileFailed`: the editor compiles this without strict mode. */
export function materialUnavailable(
  result: MaterialAcquireResult,
): result is UnavailableMaterial {
  return result.ok === false;
}

export function materialAvailable(
  result: MaterialAcquireResult,
): result is AcquiredMaterial {
  return result.ok === true;
}

export type MaterialAcquireOptions = {
  unlit?: boolean;
  instanceKey?: string;
};

export type MaterialResolveOptions = MaterialAcquireOptions & {
  parameters?: ReadonlyMap<string, MaterialParameterValue>;
};

function cacheKey(
  assetGuid: string,
  unlit?: boolean,
  instanceKey?: string,
): string {
  const key = unlit ? `${assetGuid}:unlit` : assetGuid;
  return instanceKey === undefined ? key : JSON.stringify([key, instanceKey]);
}

function documentForPlan(
  doc: MaterialDocument,
  unlit?: boolean,
): MaterialDocument {
  if (!unlit || doc.shadingModel === "unlit") return doc;
  return { ...doc, shadingModel: "unlit" };
}

export interface MaterialLibraryOptions {
  resolveTexture?: (guid: string) => Texture | null;
  functions?: () => Record<string, MaterialFunctionDocument>;
  onTextureError?: (diagnostic: MaterialDiagnostic) => void;
  onMaterialReady?: (scene: Scene, assetGuid: string) => void;
}

interface CacheEntry {
  material: NodeMaterial;
  hash: string;
  refCount: number;
  dispose: () => void;
  setParameter: (name: string, parameter: MaterialParameterValue) => boolean;
  instanceKey?: string;
  ready: Promise<readonly MaterialDiagnostic[]>;
}

/**
 * Scene-local cache of compiled materials.
 *
 * A Babylon material belongs to exactly one Scene, so the editor viewport,
 * a preview tab and a Play session each get their own instance even when they
 * are showing the same asset. Entries are keyed by asset guid plus the content
 * hash of the lowered plan, so editing a graph compiles a new material and
 * releasing the last reference disposes the old one.
 */
export class MaterialLibrary {
  private readonly scenes = new WeakMap<Scene, Map<string, CacheEntry>>();
  private readonly pending = new WeakMap<Scene, Map<string, CacheEntry>>();
  private readonly tracked = new Set<Scene>();
  private readonly options: MaterialLibraryOptions;

  constructor(options: MaterialLibraryOptions = {}) {
    this.options = options;
  }

  private entriesFor(scene: Scene): Map<string, CacheEntry> {
    const existing = this.scenes.get(scene);
    if (existing) return existing;
    const created = new Map<string, CacheEntry>();
    this.scenes.set(scene, created);
    this.pending.set(scene, new Map());
    this.tracked.add(scene);
    return created;
  }

  private planFor(doc: MaterialDocument, unlit?: boolean) {
    return lowerMaterialDocument(documentForPlan(doc, unlit), {
      functions: this.options.functions?.() ?? {},
    });
  }

  isCompiled(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialAcquireOptions,
  ): boolean {
    const lowered = this.planFor(doc, options?.unlit);
    if (!lowered.ok) return false;
    const entries = this.entriesFor(scene);
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey);
    const entry = this.pending.get(scene)?.get(key) ?? entries.get(key);
    return (
      entry !== undefined &&
      entry.hash === lowered.plan.hash &&
      !isDisposedNodeMaterial(entry.material, scene)
    );
  }

  /**
   * Compile (or reuse) the material for `assetGuid` in `scene` and take a
   * reference to it. Callers must `release` when they stop using it.
   */
  acquire(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialAcquireOptions,
  ): MaterialAcquireResult {
    const unlit = options?.unlit === true;
    const lowered = this.planFor(doc, unlit);
    if (!lowered.ok) {
      return { ok: false, diagnostics: lowered.diagnostics };
    }
    const key = cacheKey(assetGuid, unlit, options?.instanceKey);
    const entries = this.entriesFor(scene);
    const existing = entries.get(key);
    const pending = this.pending.get(scene)!;
    const waiting = pending.get(key);
    if (waiting?.hash === lowered.plan.hash && !isDisposedNodeMaterial(waiting.material, scene)) {
      waiting.refCount += 1;
      return { ok: true, material: waiting.material, hash: waiting.hash, ready: waiting.ready };
    }
    if (waiting) { pending.delete(key); waiting.dispose(); }
    if (
      existing &&
      existing.hash === lowered.plan.hash &&
      !isDisposedNodeMaterial(existing.material, scene)
    ) {
      existing.refCount += 1;
      return { ok: true, material: existing.material, hash: existing.hash, ready: existing.ready };
    }

    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: unlit ? `material:${assetGuid}:unlit` : `material:${assetGuid}`,
      resolveTexture: this.options.resolveTexture,
      onTextureError: this.options.onTextureError,
    });
    if (materialCompileFailed(compiled)) {
      return { ok: false, diagnostics: compiled.diagnostics };
    }
    const candidate: CacheEntry = {
      material: compiled.material,
      hash: lowered.plan.hash,
      refCount: (waiting?.refCount ?? existing?.refCount ?? 0) + 1,
      dispose: compiled.dispose,
      setParameter: compiled.setParameter,
      instanceKey: options?.instanceKey,
      ready: compiled.ready,
    };
    const publish = () => {
      if (existing) {
        // Runtime assignments can already point at the previous generation.
        for (const mesh of scene.meshes) {
          if (mesh.material === existing.material) { mesh.material = candidate.material; applyMaterialBounds(mesh); }
        }
        existing.dispose();
      }
      entries.set(key, candidate);
    };
    if (compiled.buildState === "ready") publish();
    else {
      pending.set(key, candidate);
      void compiled.ready.then((errors) => {
        if (pending.get(key) !== candidate) return;
        pending.delete(key);
        if (errors.length) {
          if (existing) existing.refCount = candidate.refCount;
          candidate.dispose();
          for (const error of errors) this.options.onTextureError?.(error);
          return;
        }
        publish();
        this.options.onMaterialReady?.(scene, assetGuid);
      });
    }
    return { ok: true, material: compiled.material, hash: lowered.plan.hash, ready: compiled.ready };
  }

  release(
    scene: Scene,
    assetGuid: string,
    options?: MaterialAcquireOptions,
  ): void {
    const entries = this.scenes.get(scene);
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey);
    const waiting = this.pending.get(scene)?.get(key);
    if (waiting) {
      waiting.refCount -= 1;
      const previous = entries?.get(key);
      if (previous) previous.refCount = waiting.refCount;
      if (waiting.refCount <= 0) {
        this.pending.get(scene)!.delete(key);
        waiting.dispose();
        previous?.dispose();
        entries?.delete(key);
      }
      return;
    }
    const entry = entries?.get(key);
    if (!entries || !entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.dispose();
    entries.delete(key);
  }

  releaseScene(scene: Scene): void {
    const entries = this.scenes.get(scene);
    if (!entries) return;
    for (const entry of entries.values()) entry.dispose();
    const pending = this.pending.get(scene);
    if (pending) { for (const entry of pending.values()) entry.dispose(); pending.clear(); }
    entries.clear();
    this.scenes.delete(scene);
    this.pending.delete(scene);
    this.tracked.delete(scene);
  }

  /** Resolve without taking another reference on every mesh rebuild. */
  resolve(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialResolveOptions,
  ): NodeMaterial | null {
    let material = this.materialFor(scene, assetGuid, options);
    if (!material || !this.isCompiled(scene, assetGuid, doc, options)) {
      const acquired = this.acquire(scene, assetGuid, doc, options);
      if (materialAvailable(acquired)) {
        if (material) this.release(scene, assetGuid, options);
        material = this.materialFor(scene, assetGuid, options) ?? acquired.material;
      }
    }
    if (!material) return null;
    for (const [name, value] of options?.parameters ?? []) {
      this.setParameter(scene, assetGuid, name, value, options);
    }
    return material;
  }

  /** Drop a component's private materials when its assignment changes or it despawns. */
  releaseInstance(instanceKey: string): void {
    for (const scene of this.tracked) {
      const pending = this.pending.get(scene)!;
      for (const [key, entry] of pending) {
        if (entry.instanceKey !== instanceKey) continue;
        pending.delete(key);
        entry.dispose();
      }
      const entries = this.scenes.get(scene)!;
      for (const [key, entry] of entries) {
        if (entry.instanceKey !== instanceKey) continue;
        entry.dispose();
        entries.delete(key);
      }
    }
  }

  acceptsParameter(
    doc: MaterialDocument,
    name: string,
    parameter: MaterialParameterValue,
  ): boolean {
    return (
      doc.nodes.some(
        (node) =>
          node.type === `param.${parameter.kind}` &&
          typeof node.properties.name === "string" &&
          node.properties.name.trim() === name,
      ) && validMaterialParameterValue(parameter, this.options.resolveTexture)
    );
  }

  setParameter(
    scene: Scene,
    assetGuid: string,
    name: string,
    parameter: MaterialParameterValue,
    options?: MaterialAcquireOptions,
  ): boolean {
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey);
    const entry = this.pending.get(scene)?.get(key) ?? this.scenes.get(scene)?.get(key);
    if (!entry || isDisposedNodeMaterial(entry.material, scene)) return false;
    return entry.setParameter(name, parameter);
  }

  /**
   * Drop every cached material so the next `acquire` rebuilds. Used after a
   * WebGL context restore, when NodeMaterials are still JS-alive but GPU-dead.
   */
  invalidate(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }

  /** Recompile changed dependencies while retaining the last usable generation. */
  markDirty(): void {
    for (const scene of this.tracked) {
      for (const entry of this.scenes.get(scene)?.values() ?? []) entry.hash = "";
      const pending = this.pending.get(scene);
      for (const [key, entry] of pending ?? []) {
        const previous = this.scenes.get(scene)?.get(key);
        if (previous) previous.refCount = entry.refCount;
        entry.dispose();
      }
      pending?.clear();
    }
  }

  cancelPending(scene: Scene, assetGuid: string): void {
    const pending = this.pending.get(scene);
    const entry = pending?.get(assetGuid);
    if (!entry) return;
    pending!.delete(assetGuid);
    const previous = this.scenes.get(scene)?.get(assetGuid);
    if (previous) previous.refCount = entry.refCount;
    entry.dispose();
  }

  /** Compile shaders before first draw so a mobile GPU does not stall. */
  async prewarm(
    scene: Scene,
    assetGuid: string,
    mesh: Mesh | null,
  ): Promise<void> {
    const entry = this.pending.get(scene)?.get(assetGuid) ?? this.scenes.get(scene)?.get(assetGuid);
    if (!entry) return;
    await prewarmMaterial(entry.material, mesh);
  }

  materialFor(
    scene: Scene,
    assetGuid: string,
    options?: MaterialAcquireOptions,
  ): NodeMaterial | null {
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey);
    const entry = this.scenes.get(scene)?.get(key) ?? this.pending.get(scene)?.get(key);
    if (!entry) return null;
    if (isDisposedNodeMaterial(entry.material, scene)) return null;
    return entry.material;
  }

  dispose(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }
}
