import type { Mesh, NodeMaterial, Scene, Texture } from "@babylonjs/core";
import {
  lowerMaterialDocument,
  type MaterialDiagnostic,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
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

export interface MaterialLibraryOptions {
  resolveTexture?: (guid: string) => Texture | null;
  functions?: () => Record<string, MaterialFunctionDocument>;
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

  private planFor(doc: MaterialDocument) {
    return lowerMaterialDocument(doc, {
      functions: this.options.functions?.() ?? {},
    });
  }

  isCompiled(scene: Scene, assetGuid: string, doc: MaterialDocument): boolean {
    const lowered = this.planFor(doc);
    if (!lowered.ok) return false;
    const entry = this.entriesFor(scene).get(assetGuid);
    return entry?.hash === lowered.plan.hash;
  }

  /**
   * Compile (or reuse) the material for `assetGuid` in `scene` and take a
   * reference to it. Callers must `release` when they stop using it.
   */
  acquire(
    scene: Scene,
    assetGuid: string,
    doc: MaterialDocument,
  ): MaterialAcquireResult {
    const lowered = this.planFor(doc);
    if (!lowered.ok) {
      return { ok: false, diagnostics: lowered.diagnostics };
    }
    const entries = this.entriesFor(scene);
    const existing = entries.get(assetGuid);
    if (existing && existing.hash === lowered.plan.hash) {
      existing.refCount += 1;
      return { ok: true, material: existing.material, hash: existing.hash };
    }

    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: `material:${assetGuid}`,
      resolveTexture: this.options.resolveTexture,
    });
    if (materialCompileFailed(compiled)) {
      return { ok: false, diagnostics: compiled.diagnostics };
    }
    // Replace only after the new material builds, so a failed edit leaves the
    // previous material on screen.
    if (existing) {
      existing.dispose();
      entries.delete(assetGuid);
    }
    entries.set(assetGuid, {
      material: compiled.material,
      hash: lowered.plan.hash,
      refCount: (existing?.refCount ?? 0) + 1,
      dispose: compiled.dispose,
    });
    return { ok: true, material: compiled.material, hash: lowered.plan.hash };
  }

  release(scene: Scene, assetGuid: string): void {
    const entries = this.scenes.get(scene);
    const entry = entries?.get(assetGuid);
    if (!entries || !entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    entry.dispose();
    entries.delete(assetGuid);
  }

  releaseScene(scene: Scene): void {
    const entries = this.scenes.get(scene);
    if (!entries) return;
    for (const entry of entries.values()) entry.dispose();
    entries.clear();
    this.scenes.delete(scene);
    this.tracked.delete(scene);
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

  materialFor(scene: Scene, assetGuid: string): NodeMaterial | null {
    return this.scenes.get(scene)?.get(assetGuid)?.material ?? null;
  }

  dispose(): void {
    for (const scene of [...this.tracked]) this.releaseScene(scene);
  }
}
