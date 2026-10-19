import { materialTextureBindings, type ResourceLease } from "./resource-cache";
import type { Material, NodeMaterial, Observer, Scene, Texture } from "@babylonjs/core";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import {
  lowerMaterialDocument,
  type MaterialBuildPlan,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialLowerResult,
} from "@babylonslate/shader-graph";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { validMaterialParameterValue } from "./material-parameters";
import { applyMaterialBounds } from "./material-bounds";
import { markSceneReadinessDirty, onSceneReceiversChanged } from "./scene-readiness-signal";
import { shaderLinkLog } from "./material-glsl-diagnostics";
import {
  compileMaterialPlan,
  MaterialCompileStalled,
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

/** Move every mesh, including nested MultiMaterial slots, from one generation to another. */
function rebindMaterial(scene: Scene, from: Material, to: Material): void {
  const replaceSubmaterials = (material: Material) => {
    if (!(material instanceof MultiMaterial)) return;
    material.subMaterials = material.subMaterials.map((child) => {
      if (child === from) return to;
      if (child) replaceSubmaterials(child);
      return child;
    });
  };
  for (const mesh of scene.meshes) {
    if (mesh.material === from) { mesh.material = to; applyMaterialBounds(mesh); }
    else if (mesh.material) replaceSubmaterials(mesh.material);
  }
}

const NO_FUNCTIONS: Record<string, MaterialFunctionDocument> = Object.freeze({});

type PlanSlot = { functions: Record<string, MaterialFunctionDocument>; content: string; result: MaterialLowerResult };

/**
 * A failure that follows from the plan itself, so the same plan fails again: not a cancellation, not a texture that
 * is not ready (its own preparation reports it, and the generation hash carries the texture's identity), and not a
 * stall (a compile that saw no shader finish for its bound says nothing about the program).
 */
function failsPlan(diagnostics: readonly MaterialDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => !NOT_THE_PLAN.has(diagnostic.code));
}
const NOT_THE_PLAN: ReadonlySet<string> = new Set(["material.compile.cancelled", "material.missingTexture", "material.compile.stalled"]);

function documentForPlan(
  doc: MaterialDocument,
  unlit?: boolean,
): MaterialDocument {
  if (!unlit || doc.shadingModel === "unlit") return doc;
  return { ...doc, shadingModel: "unlit" };
}

export interface MaterialLibraryOptions {
  particlePreview?: boolean;
  acquireTexture?: (guid: string, scene: Scene) => ResourceLease<Texture> | null;
  textureIdentity?: (guid: string) => string | undefined;
  resolveTexture?: (guid: string) => Texture | null;
  /** Return a new record whenever a function document changes; lowering is
   * memoized on the record's identity, so in-place mutation is not observed. */
  functions?: () => Record<string, MaterialFunctionDocument>;
  onTextureError?: (diagnostic: MaterialDiagnostic) => void;
  onMaterialReady?: (scene: Scene, assetGuid: string) => void;
  /**
   * Compile a first acquisition for the meshes already bound to it before `ready` settles, as a replacement
   * always is. For a host that binds at acquisition and captures right after (a thumbnail): nothing else
   * compiles until its own readiness wait, and a program that cannot link must fail the capture through
   * `ready`. A Scene host leaves it off, because its warm-up compiles under the Scene's final lighting and fog.
   */
  warmFirstAcquisition?: boolean;
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
  /**
   * The newest plan of each asset (and shading variant) that failed, with its diagnostics, shared by its instance keys:
   * their copies compile the same program. A request for that hash fails at once instead of compiling again, because
   * the Engine hands a retry the failed program from its cache without telling anyone, so a bound retry would never
   * become ready. A different hash (an edited graph, function or texture), `markDirty` and `releaseScene` end it; a
   * release does not, because the next holder would adopt the same dead program.
   */
  private readonly failures = new WeakMap<Scene, Map<string, { hash: string; diagnostics: readonly MaterialDiagnostic[] }>>();
  private readonly tracked = new Set<Scene>();
  private readonly disposeObservers = new WeakMap<Scene, Observer<Scene>>();
  private readonly receiverSubscriptions = new WeakMap<Scene, () => void>();
  // Reuse one lowering per document, shading variant and functions record
  // while the document content is unchanged (hosts may edit documents in place).
  private readonly plans = new WeakMap<MaterialDocument, { lit?: PlanSlot; unlit?: PlanSlot }>();
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
    this.failures.set(scene, new Map());
    this.tracked.add(scene);
    // SceneLayer scenes are disposed without releaseScene. Babylon notifies
    // before it disposes materials, so the library retires its own first.
    const observer = scene.onDisposeObservable.addOnce(() => this.releaseScene(scene));
    if (observer) this.disposeObservers.set(scene, observer);
    // A program can fail to link for the lights and shadow maps its receivers bind (a varying or uniform limit).
    this.receiverSubscriptions.set(scene, onSceneReceiversChanged(scene, () => this.forgetFailures(scene)));
    return created;
  }

  /** Resolve the same function-aware plan as acquire, without taking GPU ownership.
   * The lowering is memoized per document content and functions-record identity. */
  planFor(doc: MaterialDocument, unlit?: boolean): MaterialLowerResult {
    const functions = this.options.functions?.() ?? NO_FUNCTIONS;
    let slots = this.plans.get(doc);
    if (!slots) this.plans.set(doc, (slots = {}));
    const variant = unlit ? "unlit" : "lit";
    const cached = slots[variant];
    // Serializing is far cheaper than lowering and catches in-place edits.
    const content = JSON.stringify(doc);
    if (cached?.functions === functions && cached.content === content) return cached.result;
    const result = lowerMaterialDocument(documentForPlan(doc, unlit), { functions });
    slots[variant] = { functions, content, result };
    return result;
  }

  isCompiled(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialAcquireOptions,
  ): boolean {
    return this.isCompiledPlan(scene, assetGuid, this.planFor(doc, options?.unlit), options);
  }

  private isCompiledPlan(scene: Scene, assetGuid: string, lowered: MaterialLowerResult, options?: MaterialAcquireOptions): boolean {
    if (!lowered.ok || scene.isDisposed) return false;
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
   * `ready` settles once the graph is built and its textures are admitted. Only a
   * replacement also links its program for the meshes bound to it; a first acquisition's
   * program links when its host warms or probes it, and a link failure then reaches
   * `onTextureError` and retires the generation. A plan whose compile failed (or whose
   * program, or one of its surface variants, could not link) fails again at once with the
   * same diagnostics until its hash changes.
   */
  acquire(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialAcquireOptions,
  ): MaterialAcquireResult {
    return this.acquirePlan(scene, assetGuid, doc, this.planFor(doc, options?.unlit === true), options);
  }

  /** `acquire` with the document's plan already resolved (`planFor` serializes the whole document). */
  private acquirePlan(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    lowered: MaterialLowerResult,
    options?: MaterialAcquireOptions,
  ): MaterialAcquireResult {
    const unlit = options?.unlit === true;
    if (!lowered.ok) {
      return { ok: false, diagnostics: lowered.diagnostics };
    }
    const denied = options?.validatePlan?.(lowered.plan);
    if (denied) return { ok: false, diagnostics: [denied] };
    // A disposed Scene no longer notifies disposal, so nothing could release it.
    if (scene.isDisposed) return { ok: false, diagnostics: [{ code: "material.compile.cancelled", message: "Material scene was disposed", severity: "error" }] };
    const key = cacheKey(assetGuid, unlit, options?.instanceKey, options?.logicalSceneBuffers);
    const entries = this.entriesFor(scene);
    const existing = entries.get(key);
    const pending = this.pending.get(scene)!;
    const waiting = pending.get(key);
    const hash = this.generationHash(lowered.plan);
    if (waiting?.hash === hash && !isDisposedNodeMaterial(waiting.material, scene)) {
      waiting.refCount += 1;
      return { ok: true, material: waiting.material, hash: waiting.hash, plan: lowered.plan, ready: waiting.ready };
    }
    // An unpublished generation can already be bound (resolve() returns it) and
    // its count covers every reference to this key. The generation that replaces
    // it inherits both, so a superseded build never stays on a mesh disposed.
    const supersede = (successor: CacheEntry) => {
      if (!waiting) return;
      pending.delete(key);
      rebindMaterial(scene, waiting.material, successor.material);
      waiting.dispose();
    };
    if (
      existing &&
      existing.hash === hash &&
      !isDisposedNodeMaterial(existing.material, scene)
    ) {
      existing.refCount = (waiting?.refCount ?? existing.refCount) + 1;
      supersede(existing);
      return { ok: true, material: existing.material, hash: existing.hash, plan: lowered.plan, ready: existing.ready };
    }
    const failures = this.failures.get(scene)!;
    const failureKey = cacheKey(assetGuid, unlit, undefined, options?.logicalSceneBuffers);
    const failed = failures.get(failureKey);
    if (failed?.hash === hash) return { ok: false, diagnostics: [...failed.diagnostics] };

    const textures = materialTextureBindings(this.options.acquireTexture ? (guid) => this.options.acquireTexture!(guid, scene) : undefined, this.options.textureIdentity);
    let compiled: ReturnType<typeof compileMaterialPlan>;
    // Instances compile under their root Material's name so generated block
    // names, and therefore the shader text, match and the GPU program is shared.
    const programGuid = doc.instanceOf ?? assetGuid;
    const materialName = unlit ? `material:${assetGuid}:unlit` : `material:${assetGuid}`;
    let retireUnlinkable: (diagnostic: MaterialDiagnostic) => void = () => {};
    try { compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: unlit ? `material:${programGuid}:unlit` : `material:${programGuid}`,
      particlePreview: this.options.particlePreview,
      overlay: unlit,
      logicalSceneBuffers: options?.logicalSceneBuffers,
      resolveTexture: this.options.acquireTexture ? textures.resolve : this.options.resolveTexture,
      onTextureError: this.options.onTextureError,
      onLinkError: (diagnostic) => retireUnlinkable(diagnostic),
    }); } catch (error) {
      textures.dispose();
      throw error;
    }
    if (materialCompileFailed(compiled)) {
      textures.dispose();
      if (failsPlan(compiled.diagnostics)) failures.set(failureKey, { hash, diagnostics: compiled.diagnostics });
      return { ok: false, diagnostics: compiled.diagnostics };
    }
    compiled.material.name = compiled.material.id = materialName;
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
        // A first acquisition has no predecessor to protect: its users are bound to
        // it already and the host compiles what it draws, in a load's warm-up or a
        // frame's readiness probe. Warming here ran before the Scene's lighting,
        // fog and transforms were final, and built variants nothing draws. A host
        // that captures right after acquiring asks for it (`warmFirstAcquisition`).
        if (existing || this.options.warmFirstAcquisition) for (const mesh of scene.meshes) {
          if (!(mesh instanceof Mesh) || !mesh.getTotalVertices() || !uses(mesh.material)) continue;
          if (retired || scene.isDisposed) return [cancelledDiagnostic()];
          await prewarmMaterial(compiled.material, mesh);
        }
        return retired || scene.isDisposed ? [cancelledDiagnostic()] : [];
      } catch (error) {
        // Babylon rejects a failed compile with the shader log itself, a string.
        const log = error instanceof Error ? error.message : typeof error === "string" ? shaderLinkLog(error) : "";
        const code = error instanceof MaterialCompileStalled ? "material.compile.stalled" : "material.compile.failed";
        return [{ code, message: log || "Material shader preparation failed", severity: "error" as const }];
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
    // A parameter replaced while its texture prepares settles its request as cancelled: the replacement's request (and
    // any later one) is awaited instead, and only the failures still current count, so replacing a texture never
    // fails the generation.
    const prepareParameters = async (): Promise<readonly MaterialDiagnostic[]> => {
      while (pendingParameters.size) await Promise.all([...pendingParameters.values()].map((request) => request.ready));
      return [...parameterFailures.values()].flat();
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
      // Only texture writes can change sampled textures or pending requests.
      if (value.kind === "texture") pruneTextures();
      return accepted;
    };
    const candidate: CacheEntry = {
      assetGuid,
      material: compiled.material,
      hash,
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
        rebindMaterial(scene, existing.material, candidate.material);
        existing.dispose();
      }
      entries.set(key, candidate);
    };
    // A first acquisition is not compiled here, so a program the Engine cannot link first surfaces when a readiness
    // probe or a draw creates its Effect, with the generation already bound. It never becomes ready, which would
    // hold every frame of the Scene. Retire it as a failed warm-up did: report the compiler's log and let its
    // meshes fall back to the default Material. Babylon reports from inside the Effect's link, so retire afterwards.
    // The disposed entry stays in its map: holders still own its reference count, which the next acquisition of the
    // key inherits (and replaces), so a holder's later `release` never lands on a newer generation.
    let unlinkable = false;
    retireUnlinkable = (diagnostic) => queueMicrotask(() => {
      // An adopted instance moved to its component's key (`adoptPreparedInstance` rewrites `instanceKey`).
      const heldKey = cacheKey(assetGuid, unlit, candidate.instanceKey, options?.logicalSceneBuffers);
      const current = entries.get(heldKey) === candidate || pending.get(heldKey) === candidate;
      if (!current || unlinkable || scene.isDisposed) return;
      unlinkable = true;
      failures.set(failureKey, { hash, diagnostics: [diagnostic] });
      if (existing && pending.get(heldKey) === candidate && !isDisposedNodeMaterial(existing.material, scene)) {
        existing.refCount = candidate.refCount;
        rebindMaterial(scene, candidate.material, existing.material);
      }
      candidate.dispose();
      markSceneReadinessDirty(scene);
      if (this.options.onTextureError) this.options.onTextureError(diagnostic);
      else console.warn(`[render] Material "${assetGuid}" could not be linked: ${diagnostic.message}`);
    });
    {
      supersede(candidate);
      pending.set(key, candidate);
      void ready.then((errors) => {
        if (unlinkable || pending.get(key) !== candidate) return;
        pending.delete(key);
        if (errors.length) {
          // A predecessor retired meanwhile (an unlinkable generation, a release) has no meshes to take back.
          if (existing && !isDisposedNodeMaterial(existing.material, scene)) {
            existing.refCount = candidate.refCount;
            rebindMaterial(scene, candidate.material, existing.material);
          }
          candidate.dispose();
          if (failsPlan(errors)) failures.set(failureKey, { hash, diagnostics: errors });
          for (const error of errors) this.options.onTextureError?.(error);
          return;
        }
        preparingTextures = false;
        pruneTextures();
        publish();
        this.options.onMaterialReady?.(scene, assetGuid);
      });
    }
    return { ok: true, material: compiled.material, hash, plan: lowered.plan, ready };
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
    const observer = this.disposeObservers.get(scene);
    if (observer) { scene.onDisposeObservable.remove(observer); this.disposeObservers.delete(scene); }
    this.receiverSubscriptions.get(scene)?.();
    this.receiverSubscriptions.delete(scene);
    for (const entry of entries.values()) entry.dispose();
    const pending = this.pending.get(scene);
    if (pending) { for (const entry of pending.values()) entry.dispose(); pending.clear(); }
    entries.clear();
    this.scenes.delete(scene);
    this.pending.delete(scene);
    this.failures.delete(scene);
    this.tracked.delete(scene);
  }

  /** Resolve without taking another reference on every mesh rebuild. */
  resolve(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialResolveOptions,
  ): NodeMaterial | null {
    return this.resolvePlan(scene, assetGuid, doc, options)?.material ?? null;
  }

  /**
   * `resolve` that also reports `isReady` for the resolved generation, from the
   * plan `resolve` already computed. A host that needs both does not lower (and
   * serialize the document) a second time per resolved binding.
   */
  resolveWithReadiness(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialResolveOptions,
  ): { material: NodeMaterial; ready: boolean } | null {
    const resolved = this.resolvePlan(scene, assetGuid, doc, options);
    return resolved && { material: resolved.material, ready: this.isReadyPlan(scene, assetGuid, resolved.lowered, options) };
  }

  private resolvePlan(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
    options?: MaterialResolveOptions,
  ): { material: NodeMaterial; lowered: MaterialLowerResult } | null {
    let material = this.materialFor(scene, assetGuid, options);
    const lowered = this.planFor(doc, options?.unlit);
    if (!material || !this.isCompiledPlan(scene, assetGuid, lowered, options)) {
      const acquired = this.acquirePlan(scene, assetGuid, doc, lowered, options);
      if (materialAvailable(acquired)) {
        if (material) this.release(scene, assetGuid, options);
        material = this.materialFor(scene, assetGuid, options) ?? acquired.material;
      }
    }
    if (!material) return null;
    for (const [name, value] of options?.parameters ?? []) {
      this.setParameter(scene, assetGuid, name, value, options);
    }
    return { material, lowered };
  }

  /** Retire one replaced asset, or all private materials when the owner despawns. */
  adoptPreparedInstance(scene: Scene, assetGuid: string, preparedKey: string, targetKey: string,
    material: NodeMaterial, options?: Pick<MaterialAcquireOptions, "unlit" | "logicalSceneBuffers">): { commit(): void; rollback(): void } {
    const entries = this.scenes.get(scene);
    const from = cacheKey(assetGuid, options?.unlit, preparedKey, options?.logicalSceneBuffers);
    const to = cacheKey(assetGuid, options?.unlit, targetKey, options?.logicalSceneBuffers);
    const entry = entries?.get(from);
    if (!entry || entry.material !== material || scene.isDisposed || isDisposedNodeMaterial(material, scene) || this.pending.get(scene)?.has(from))
      throw new Error("The prepared material instance is no longer available.");
    if (this.pending.get(scene)?.has(to)) throw new Error("The current material instance is still preparing another replacement.");
    const previous = entries!.get(to);
    entries!.delete(from);
    entry.instanceKey = targetKey;
    entries!.set(to, entry);
    // The caller moves native consumers synchronously before releasing their predecessor.
    let resolved = false;
    return {
      commit: () => { if (!resolved) { resolved = true; previous?.dispose(); } },
      rollback: () => {
        if (resolved) return;
        resolved = true;
        if (entries!.get(to) !== entry) throw new Error("Prepared material ownership changed during commit.");
        if (previous) entries!.set(to, previous); else entries!.delete(to);
        entry.instanceKey = preparedKey;
        entries!.set(from, entry);
      },
    };
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

  /** The generation is published: its graph built and its textures were admitted. Its program links later (see `acquire`). */
  isReady(scene: Scene, assetGuid: string, doc: MaterialDocument, options?: MaterialAcquireOptions): boolean {
    return this.isReadyPlan(scene, assetGuid, this.planFor(doc, options?.unlit), options);
  }

  private isReadyPlan(scene: Scene, assetGuid: string, plan: MaterialLowerResult, options?: MaterialAcquireOptions): boolean {
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
      // A changed dependency may let a plan that failed compile.
      this.failures.get(scene)?.clear();
    }
  }

  /**
   * Forget the plans that failed in `scene`, so the next request compiles again. The Scene does this itself when its
   * lights or shadow maps change (`onSceneReceiversChanged`): a program can fail to link for the set its receivers
   * bind and link without it, while the plan hash stays the same. Cheap, and unlike `markDirty` it touches no entry.
   */
  forgetFailures(scene: Scene): void {
    this.failures.get(scene)?.clear();
  }

  /** Cancel every unpublished generation of an asset, whatever its variant or instance key. */
  cancelPending(scene: Scene, assetGuid: string): void {
    const pending = this.pending.get(scene);
    for (const [key, entry] of pending ?? []) {
      if (entry.assetGuid !== assetGuid) continue;
      pending!.delete(key);
      const previous = this.scenes.get(scene)?.get(key);
      if (previous) previous.refCount = entry.refCount;
      entry.dispose();
    }
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
    this.invalidate();
  }
}
