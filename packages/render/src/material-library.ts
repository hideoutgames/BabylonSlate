import { materialTextureBindings, type ResourceLease } from "./resource-cache";
import type { Material, NodeMaterial, Scene, Texture } from "@babylonjs/core";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import {
  lowerMaterialDocument,
  type MaterialBuildPlan,
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
  /** Fully resolved plan used for this acquisition, including nested functions. */
  plan: MaterialBuildPlan;
  ready: Promise<readonly MaterialDiagnostic[]>;
}

export interface UnavailableMaterial {
  ok: false;
  diagnostics: MaterialDiagnostic[];
}

export type MaterialAcquireResult = AcquiredMaterial | UnavailableMaterial;

const ownedPreparations = new WeakMap<Material, () => Promise<readonly MaterialDiagnostic[]>>();

/** Borrow the exact currently requested library preparation without acquiring.
 * A working material can still represent a pending replacement returned by resolve(). */
export function ownedMaterialPreparation(material: Material): Promise<readonly MaterialDiagnostic[]> | undefined {
  return ownedPreparations.get(material)?.();
}

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
  logicalSceneBuffers?: boolean;
  unlit?: boolean;
  instanceKey?: string;
  /** Reject a resolved plan before compilation or taking a cached reference. */
  validatePlan?: (plan: MaterialBuildPlan) => MaterialDiagnostic | undefined;
};

export type MaterialResolveOptions = MaterialAcquireOptions & {
  parameters?: ReadonlyMap<string, MaterialParameterValue>;
};

function cacheKey(
  assetGuid: string,
  unlit?: boolean,
  instanceKey?: string,
  logicalSceneBuffers?: boolean,
): string {
  const key = unlit ? `${assetGuid}:unlit` : assetGuid;
  return logicalSceneBuffers ? JSON.stringify([key, instanceKey ?? null, "logicalSceneBuffers"])
    : instanceKey === undefined ? key : JSON.stringify([key, instanceKey]);
}

function documentForPlan(
  doc: MaterialDocument,
  unlit?: boolean,
): MaterialDocument {
  if (!unlit || doc.shadingModel === "unlit") return doc;
  return { ...doc, shadingModel: "unlit" };
}

export interface MaterialLibraryOptions {
  particlePreview?: boolean;
  acquireTexture?: (guid: string) => ResourceLease<Texture> | null;
  textureIdentity?: (guid: string) => string | undefined;
  resolveTexture?: (guid: string) => Texture | null;
  functions?: () => Record<string, MaterialFunctionDocument>;
  onTextureError?: (diagnostic: MaterialDiagnostic) => void;
  onMaterialReady?: (scene: Scene, assetGuid: string) => void;
}

interface CacheEntry {
  assetGuid: string;
  material: NodeMaterial;
  hash: string;
  refCount: number;
  dispose: () => void;
  setParameter: (name: string, parameter: MaterialParameterValue) => boolean;
  getParameter: (name: string) => MaterialParameterValue | null;
  resetParameter: (name: string) => boolean;
  instanceKey?: string;
  ready: Promise<readonly MaterialDiagnostic[]>;
  preparation: () => Promise<readonly MaterialDiagnostic[]>;
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

  private generationHash(plan: MaterialBuildPlan): string {
    if (!this.options.textureIdentity) return plan.hash;
    return JSON.stringify([plan.hash, plan.textures.map((texture) => [texture.textureGuid, this.options.textureIdentity!(texture.textureGuid) ?? null])]);
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

  /** Resolve the same function-aware plan as acquire, without taking GPU ownership. */
  planFor(doc: MaterialDocument, unlit?: boolean) {
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
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entry = this.pending.get(scene)?.get(key) ?? entries.get(key);
    return (
      entry !== undefined &&
      entry.hash === this.generationHash(lowered.plan) &&
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
    const denied = options?.validatePlan?.(lowered.plan);
    if (denied) return { ok: false, diagnostics: [denied] };
    const key = cacheKey(assetGuid, unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entries = this.entriesFor(scene);
    const existing = entries.get(key);
    const pending = this.pending.get(scene)!;
    const waiting = pending.get(key);
    if (waiting?.hash === this.generationHash(lowered.plan) && !isDisposedNodeMaterial(waiting.material, scene)) {
      waiting.refCount += 1;
      return { ok: true, material: waiting.material, hash: waiting.hash, plan: lowered.plan, ready: waiting.ready };
    }
    if (waiting) { pending.delete(key); waiting.dispose(); }
    if (
      existing &&
      existing.hash === this.generationHash(lowered.plan) &&
      !isDisposedNodeMaterial(existing.material, scene)
    ) {
      existing.refCount += 1;
      return { ok: true, material: existing.material, hash: existing.hash, plan: lowered.plan, ready: existing.ready };
    }

    const textures = materialTextureBindings(this.options.acquireTexture, this.options.textureIdentity);
    let compiled: ReturnType<typeof compileMaterialPlan>;
    try { compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: unlit ? `material:${assetGuid}:unlit` : `material:${assetGuid}`,
      particlePreview: this.options.particlePreview,
      logicalSceneBuffers: options?.logicalSceneBuffers,
      resolveTexture: this.options.acquireTexture ? textures.resolve : this.options.resolveTexture,
      onTextureError: this.options.onTextureError,
    }); } catch (error) {
      textures.dispose();
      throw error;
    }
    if (materialCompileFailed(compiled)) {
      textures.dispose();
      return { ok: false, diagnostics: compiled.diagnostics };
    }
    const texturePreparations = lowered.plan.textures.flatMap((binding) => {
      const preparation = textures.ready(binding.textureGuid);
      return preparation ? [preparation] : [];
    });
    const textureFailure = (error: unknown): MaterialDiagnostic => ({
      code: "material.missingTexture",
      message: error instanceof Error ? error.message : "Material texture preparation failed",
      severity: "error",
    });
    // Native sample readiness can precede asynchronous byte accounting/admission.
    // Keep the working generation until both compilation and its owned leases settle.
    let cancelPreparation = () => {};
    const prepared: Promise<readonly MaterialDiagnostic[]> = texturePreparations.length
      ? Promise.all([compiled.ready, Promise.all(texturePreparations)]).then(
          ([diagnostics]) => diagnostics,
          (error: unknown) => [textureFailure(error)],
        )
      : compiled.ready;
    const nativePrepared = prepared.then(async (diagnostics) => {
      if (diagnostics.length) return diagnostics;
      const parameters = await prepareParameters();
      if (parameters.length) return parameters;
      const uses = (material: Material | null): boolean => material === compiled.material ||
        (existing !== undefined && material === existing.material) ||
        (material instanceof MultiMaterial && material.subMaterials.some(uses));
      try {
        // A changed graph cannot retire its predecessor before the replacement
        // compiles for its actual users, including unpublished model meshes.
        for (const mesh of scene.meshes) {
          if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || !uses(mesh.material)) continue;
          if (retired || scene.isDisposed) return [cancelledDiagnostic()];
          await prewarmMaterial(compiled.material, mesh);
        }
        return retired || scene.isDisposed ? [cancelledDiagnostic()] : [];
      } catch (error) {
        return [{ code: "material.compile.failed", message: error instanceof Error ? error.message : "Material shader preparation failed", severity: "error" as const }];
      }
    });
    let retired = false;
    const cancelledDiagnostic = (): MaterialDiagnostic => ({ code: "material.compile.cancelled", message: "Material preparation was cancelled", severity: "error" });
    const ready = Promise.race([nativePrepared, new Promise<readonly MaterialDiagnostic[]>((resolve) => {
      cancelPreparation = () => { retired = true; resolve([cancelledDiagnostic()]); };
    })]);
    const textureDefaults = new Map(lowered.plan.operations
      .filter((operation) => operation.nodeType === "param.texture" && operation.source.callPath.length === 0)
      .map((operation) => {
        const name = String(operation.properties.name ?? "").trim();
        return [name, compiled.getParameter(name)] as const;
      }));
    const pendingParameters = new Map<string, { texture: Texture; guid: string; identity: string | undefined; ready: Promise<readonly MaterialDiagnostic[]>; cancel: () => void }>();
    const parameterFailures = new Map<string, readonly MaterialDiagnostic[]>();
    const prepareParameters = () => {
      const failures = [...parameterFailures.values()].flat();
      return Promise.all([...pendingParameters.values()].map((request) => request.ready))
        .then((results) => [...results.flat(), ...failures]);
    };
    let preparingTextures = true;
    const pruneTextures = () => {
      // Initial overrides can replace a sample before the compiler's captured
      // texture preparations settle. Those preparations still own their input.
      if (preparingTextures) return;
      textures.prune([
        ...compiled.material.getAllTextureBlocks().flatMap((block) => block.texture ? [block.texture] : []),
        ...[...pendingParameters.values()].map((entry) => entry.texture),
      ]);
    };
    const cancelParameter = (name: string) => { pendingParameters.get(name)?.cancel(); pendingParameters.delete(name); };
    const setParameter = (name: string, value: MaterialParameterValue) => {
      const previous = compiled.getParameter(name);
      if (previous?.kind !== value.kind) return false;
      const pendingParameter = pendingParameters.get(name);
      if (value.kind === "texture" && value.textureAssetGuid && pendingParameter &&
        pendingParameter.guid === value.textureAssetGuid &&
        pendingParameter.identity === this.options.textureIdentity?.(value.textureAssetGuid)) return true;
      cancelParameter(name);
      parameterFailures.delete(name);
      if (this.options.acquireTexture && value.kind === "texture" && value.textureAssetGuid) {
        const guid = value.textureAssetGuid;
        const parameter = { ...value };
        const identity = this.options.textureIdentity?.(guid);
        const texture = textures.resolve(guid);
        if (!texture || texture.loadingError) {
          parameterFailures.set(name, [textureFailure(new Error(`Material texture parameter "${name}" could not acquire ${guid}`))]);
          pruneTextures();
          return false;
        }
        const preparation = textures.ready(guid);
        const alreadyBound = previous.kind === "texture" && previous.textureAssetGuid === guid &&
          compiled.material.getActiveTextures().includes(texture);
        if (!alreadyBound && (preparation || !texture.isReady())) {
          let complete!: (diagnostics: readonly MaterialDiagnostic[]) => void;
          const request = {
            texture, guid, identity,
            ready: new Promise<readonly MaterialDiagnostic[]>((resolve) => { complete = resolve; }),
            cancel: () => {},
          };
          let detach = () => {};
          const settle = (diagnostics: readonly MaterialDiagnostic[]) => {
            if (pendingParameters.get(name) !== request) return;
            pendingParameters.delete(name);
            detach();
            if (diagnostics.length) parameterFailures.set(name, diagnostics);
            complete(diagnostics);
          };
          request.cancel = () => settle([{ code: "material.compile.cancelled", message: `Material texture parameter "${name}" was cancelled`, severity: "error" }]);
          pendingParameters.set(name, request);
          const publish = () => {
            if (pendingParameters.get(name) !== request) return;
            // The completed lease belongs to the captured source generation.
            try {
              const accepted = identity === this.options.textureIdentity?.(guid) && compiled.setParameter(name, parameter);
              settle(accepted ? [] : [textureFailure(new Error(`Material texture parameter "${name}" was superseded`))]);
            } catch (error) { settle([textureFailure(error)]); }
            pruneTextures();
          };
          if (preparation) void preparation.then(publish, (error: unknown) => {
            if (pendingParameters.get(name) !== request) return;
            const diagnostic = textureFailure(error);
            settle([diagnostic]);
            pruneTextures();
            this.options.onTextureError?.(diagnostic);
          });
          else {
            const loaded = texture.onLoadObservable.addOnce(publish);
            detach = () => { texture.onLoadObservable.remove(loaded); };
          }
          pruneTextures();
          return true;
        }
      }
      const accepted = compiled.setParameter(name, value);
      pruneTextures();
      return accepted;
    };
    const candidate: CacheEntry = {
      assetGuid,
      material: compiled.material,
      hash: this.generationHash(lowered.plan),
      refCount: (waiting?.refCount ?? existing?.refCount ?? 0) + 1,
      dispose: () => { cancelPreparation(); for (const request of pendingParameters.values()) request.cancel(); pendingParameters.clear(); compiled.dispose(); textures.dispose(); },
      setParameter,
      getParameter: compiled.getParameter,
      resetParameter: (name) => {
        const value = textureDefaults.get(name);
        if (value) return setParameter(name, value);
        cancelParameter(name);
        parameterFailures.delete(name);
        const accepted = compiled.resetParameter(name);
        pruneTextures();
        return accepted;
      },
      instanceKey: options?.instanceKey,
      ready,
      preparation: () => Promise.all([ready, prepareParameters()]).then((results) => results.flat()),
    };
    ownedPreparations.set(candidate.material, () => (pending.get(key) ?? candidate).preparation());
    if (existing) ownedPreparations.set(existing.material, () => (pending.get(key) ?? existing).preparation());
    const publish = () => {
      if (existing) {
        // Runtime assignments can already point at the previous generation.
        const replaceSubmaterials = (material: Material) => {
          if (!(material instanceof MultiMaterial)) return;
          material.subMaterials = material.subMaterials.map((child) => {
            if (child === existing.material) return candidate.material;
            if (child) replaceSubmaterials(child);
            return child;
          });
        };
        for (const mesh of scene.meshes) {
          if (mesh.material === existing.material) { mesh.material = candidate.material; applyMaterialBounds(mesh); }
          else if (mesh.material) replaceSubmaterials(mesh.material);
        }
        existing.dispose();
      }
      entries.set(key, candidate);
    };
    {
      pending.set(key, candidate);
      void ready.then((errors) => {
        if (pending.get(key) !== candidate) return;
        pending.delete(key);
        if (errors.length) {
          if (existing) existing.refCount = candidate.refCount;
          candidate.dispose();
          for (const error of errors) this.options.onTextureError?.(error);
          return;
        }
        preparingTextures = false;
        pruneTextures();
        publish();
        this.options.onMaterialReady?.(scene, assetGuid);
      });
    }
    return { ok: true, material: compiled.material, hash: this.generationHash(lowered.plan), plan: lowered.plan, ready };
  }

  release(
    scene: Scene,
    assetGuid: string,
    options?: MaterialAcquireOptions,
  ): void {
    const entries = this.scenes.get(scene);
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
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

  /** Retire one replaced asset, or all private materials when the owner despawns. */
  releaseInstance(instanceKey: string, assetGuid?: string): void {
    for (const scene of this.tracked) {
      const pending = this.pending.get(scene)!;
      for (const [key, entry] of pending) {
        if (entry.instanceKey !== instanceKey || (assetGuid !== undefined && entry.assetGuid !== assetGuid)) continue;
        pending.delete(key);
        entry.dispose();
      }
      const entries = this.scenes.get(scene)!;
      for (const [key, entry] of entries) {
        if (entry.instanceKey !== instanceKey || (assetGuid !== undefined && entry.assetGuid !== assetGuid)) continue;
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
      ) && (parameter.kind === "texture" && this.options.textureIdentity
        ? !parameter.textureAssetGuid || this.options.textureIdentity(parameter.textureAssetGuid) !== undefined
        : validMaterialParameterValue(parameter, this.options.resolveTexture))
    );
  }

  setParameter(
    scene: Scene,
    assetGuid: string,
    name: string,
    parameter: MaterialParameterValue,
    options?: MaterialAcquireOptions,
  ): boolean {
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entry = this.pending.get(scene)?.get(key) ?? this.scenes.get(scene)?.get(key);
    if (!entry || isDisposedNodeMaterial(entry.material, scene)) return false;
    return entry.setParameter(name, parameter);
  }

  getParameter(scene: Scene, assetGuid: string, name: string, options?: MaterialAcquireOptions): MaterialParameterValue | null {
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entry = this.pending.get(scene)?.get(key) ?? this.scenes.get(scene)?.get(key);
    return entry && !isDisposedNodeMaterial(entry.material, scene) ? entry.getParameter(name) : null;
  }

  resetParameter(scene: Scene, assetGuid: string, name: string, options?: MaterialAcquireOptions): boolean {
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entry = this.pending.get(scene)?.get(key) ?? this.scenes.get(scene)?.get(key);
    return !!entry && !isDisposedNodeMaterial(entry.material, scene) && entry.resetParameter(name);
  }

  /**
   * Drop every cached material so the next `acquire` rebuilds. Used after a
   * WebGL context restore, when NodeMaterials are still JS-alive but GPU-dead.
   */
  invalidate(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }

  isReady(scene: Scene, assetGuid: string, doc: MaterialDocument, options?: MaterialAcquireOptions): boolean {
    const plan = this.planFor(doc, options?.unlit);
    const entry = this.scenes.get(scene)?.get(cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers));
    return plan.ok && !!entry && entry.hash === this.generationHash(plan.plan) && !isDisposedNodeMaterial(entry.material, scene);
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
    const key = cacheKey(assetGuid, options?.unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entry = this.scenes.get(scene)?.get(key) ?? this.pending.get(scene)?.get(key);
    if (!entry) return null;
    if (isDisposedNodeMaterial(entry.material, scene)) return null;
    return entry.material;
  }

  dispose(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }
}
