import type { Mesh, NodeMaterial, Scene, Texture } from "@babylonjs/core";
import {
  lowerMaterialDocument,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import {
  compileMaterialPlan,
  materialCompileFailed,
  prewarmMaterial,
} from "./material-compiler";

export interface AcquiredMaterial {
  ok: true;
  material: NodeMaterial;
  hash: string;
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
};

function cacheKey(assetGuid: string, unlit?: boolean): string {
  return unlit ? `${assetGuid}:unlit` : assetGuid;
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
}

interface CacheEntry {
  material: NodeMaterial;
  hash: string;
  refCount: number;
  dispose: () => void;
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
    const entry = this.entriesFor(scene).get(cacheKey(assetGuid, options?.unlit));
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
    const key = cacheKey(assetGuid, unlit);
    const entries = this.entriesFor(scene);
    const existing = entries.get(key);
    if (
      existing &&
      existing.hash === lowered.plan.hash &&
      !isDisposedNodeMaterial(existing.material, scene)
    ) {
      existing.refCount += 1;
      return { ok: true, material: existing.material, hash: existing.hash };
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
    // Replace only after the new material builds, so a failed edit leaves the
    // previous material on screen.
    if (existing) {
      existing.dispose();
      entries.delete(key);
    }
    entries.set(key, {
      material: compiled.material,
      hash: lowered.plan.hash,
      refCount: (existing?.refCount ?? 0) + 1,
      dispose: compiled.dispose,
    });
    return { ok: true, material: compiled.material, hash: lowered.plan.hash };
  }

  release(
    scene: Scene,
    assetGuid: string,
    options?: MaterialAcquireOptions,
  ): void {
    const entries = this.scenes.get(scene);
    const key = cacheKey(assetGuid, options?.unlit);
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
    entries.clear();
    this.scenes.delete(scene);
    this.tracked.delete(scene);
  }

  /**
   * Drop every cached material so the next `acquire` rebuilds. Used after a
   * WebGL context restore, when NodeMaterials are still JS-alive but GPU-dead.
   */
  invalidate(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }

  /** Compile shaders before first draw so a mobile GPU does not stall. */
  async prewarm(
    scene: Scene,
    assetGuid: string,
    mesh: Mesh | null,
  ): Promise<void> {
    const entry = this.scenes.get(scene)?.get(assetGuid);
    if (!entry) return;
    await prewarmMaterial(entry.material, mesh);
  }

  materialFor(
    scene: Scene,
    assetGuid: string,
    options?: MaterialAcquireOptions,
  ): NodeMaterial | null {
    const entry = this.scenes.get(scene)?.get(cacheKey(assetGuid, options?.unlit));
    if (!entry) return null;
    if (isDisposedNodeMaterial(entry.material, scene)) return null;
    return entry.material;
  }

  dispose(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }
}
