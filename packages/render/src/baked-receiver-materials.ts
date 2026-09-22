import {
  MultiMaterial,
  NodeMaterial,
  PBRBaseMaterial,
  StandardMaterial,
  type AbstractMesh,
  type Light,
  type Material,
  type Mesh,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import type {
  BakedLightingSource,
  BakedReceiverBinding,
} from "@babylonslate/core";
import { CelLightBlock } from "./cel-light-block";
import { CelMaterial } from "./cel-material";
import type { BakedIrradianceSampling } from "./baked-irradiance";
import { BakedIrradiancePlugin } from "./baked-irradiance-plugin";
import { ScenePbrLightingBlock } from "./scene-pbr-lighting-block";
import type { RuntimeIrradianceBinding } from "./scene-baked-lighting";

/** Resolves one bake light source to the live realtime light on this Scene. */
export type BakedSourceLightResolver = (
  source: Extract<BakedLightingSource, { kind: "light" }>,
) => Light | null;

/**
 * Builds one per-receiver material variant carrying the baked-irradiance
 * sampler. Shared materials are never mutated: PBR/Standard surfaces get a
 * clone with `BakedIrradiancePlugin`; CEL adapters re-wrap the same source so
 * `SLATE_BAKED` joins the environment accumulation; authored graphs clone and
 * set `CelLightBlock.bakedIrradiance`; MultiMaterial children recurse.
 * Unsupported materials return null so realtime lighting stays untouched.
 */
function bakedMaterialVariant(
  scene: Scene,
  material: Material,
  sampling: BakedIrradianceSampling,
): Material | null {
  if (material instanceof CelMaterial) {
    // An unlit adapter mirrors its source's flat color; no bake applies.
    if (material.disableLighting) return null;
    const variant = new CelMaterial(material.source, scene);
    new BakedIrradiancePlugin(variant, sampling);
    return variant;
  }
  if (material instanceof NodeMaterial) {
    const variant: Material = material.clone(`baked:${material.name}`);
    if (!(variant instanceof NodeMaterial)) {
      variant.dispose(false, false);
      return null;
    }
    const blocks = variant.attachedBlocks.filter(
      (
        block,
      ): block is CelLightBlock | ScenePbrLightingBlock =>
        block instanceof CelLightBlock ||
        block instanceof ScenePbrLightingBlock,
    );
    if (!blocks.length) {
      variant.dispose(false, false);
      return null;
    }
    for (const block of blocks) block.bakedIrradiance = sampling;
    variant.build();
    return variant;
  }
  if (material instanceof MultiMaterial) {
    const variant = new MultiMaterial(`baked:${material.name}`, scene);
    variant.subMaterials = material.subMaterials.map((child) =>
      child ? (bakedMaterialVariant(scene, child, sampling) ?? child) : child,
    );
    return variant;
  }
  if (
    material instanceof PBRBaseMaterial ||
    material instanceof StandardMaterial
  ) {
    // `unlit` lives on the PBR subclasses, `disableLighting` on both families;
    // neither material consumes lighting so the bake does not apply.
    const flags = material as { unlit?: boolean; disableLighting?: boolean };
    if (flags.unlit === true || flags.disableLighting === true) return null;
    const variant = material.clone(`baked:${material.name}`);
    if (!variant) return null;
    new BakedIrradiancePlugin(variant, sampling);
    return variant;
  }
  return null;
}

/**
 * Whether a bound variant is configured to emit the baked sample path: the
 * plugin for cloned surface materials, `bakedIrradiance` on a graph's
 * CEL/PBR lighting block, or any MultiMaterial child carrying either.
 */
function variantCarriesBake(material: Material | null): boolean {
  if (!material) return false;
  if (material.pluginManager?.getPlugin("SlateBakedIrradiance")) return true;
  if (material instanceof NodeMaterial) {
    return material.attachedBlocks.some(
      (block) =>
        (block instanceof CelLightBlock ||
          block instanceof ScenePbrLightingBlock) &&
        block.bakedIrradiance !== null,
    );
  }
  if (material instanceof MultiMaterial) {
    return material.subMaterials.some(
      (child) => child !== null && variantCarriesBake(child),
    );
  }
  return false;
}

interface AppliedReceiver {
  binding: RuntimeIrradianceBinding;
  sources: ReadonlyMap<string, BakedLightingSource>;
  lightForSource: BakedSourceLightResolver;
  original: Material | null;
  /** Null when the mesh's material cannot consume the atlas; the entry stays watched so a later supported assignment still wraps. */
  variant: Material | null;
  excludedLights: Light[];
  /** Light-kind sources that had no runtime light yet at wrap() — re-resolved on every sync. */
  pendingExclusions: Extract<BakedLightingSource, { kind: "light" }>[];
  observer: Observer<AbstractMesh>;
  retargeting: boolean;
}

/**
 * Per-receiver material binding for one admitted bake. Each bound mesh gets
 * an owned material variant plus realtime-light exclusions for the sources
 * whose direct term is baked in; release restores the exact shared material
 * and exclusion lists. A receiver whose material is reassigned mid-binding
 * (render-mode swap, late material apply) is re-wrapped around the new
 * material on the next change notification or `sync` pass.
 */
export class BakedReceiverMaterials {
  private readonly scene: Scene;
  private readonly applied = new Map<Mesh, AppliedReceiver>();
  private released = false;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * Bind one admitted receiver. `sources` is the prepared bake's source list
   * (the contribution `sourceId` keyspace); `lightForSource` resolves live
   * realtime lights for exclusion. Returns the bound variant, or null when
   * the receiver's material cannot consume the atlas (realtime is untouched).
   */
  apply(
    mesh: Mesh,
    binding: RuntimeIrradianceBinding,
    sources: ReadonlyMap<string, BakedLightingSource>,
    lightForSource: BakedSourceLightResolver,
  ): Material | null {
    if (this.released || mesh.isDisposed()) return null;
    const previous = this.applied.get(mesh);
    if (previous && previous.variant === mesh.material) {
      this.refreshExclusions(mesh, previous);
      return previous.variant;
    }
    if (previous) this.retire(mesh, previous);
    return this.wrap(mesh, binding, sources, lightForSource);
  }

  private wrap(
    mesh: Mesh,
    binding: RuntimeIrradianceBinding,
    sources: ReadonlyMap<string, BakedLightingSource>,
    lightForSource: BakedSourceLightResolver,
  ): Material | null {
    const receiver: BakedReceiverBinding = binding.receiver;
    const sampling: BakedIrradianceSampling = {
      texture: binding.texture,
      scale: receiver.scale,
      offset: receiver.offset,
      includesEnvironment: receiver.contributions.some(
        (contribution) => contribution.term === "environmentDiffuse",
      ),
    };
    const current = mesh.material;
    const source = current ?? this.scene.defaultMaterial;
    const variant = source
      ? bakedMaterialVariant(this.scene, source, sampling)
      : null;
    const entry: AppliedReceiver = {
      binding,
      sources,
      lightForSource,
      // A re-wrap after a foreign assignment restores that newer material,
      // never the variant that was replaced.
      original: current ?? null,
      variant,
      excludedLights: [],
      pendingExclusions: [],
      observer: mesh.onMaterialChangedObservable.add(() => {
        const applied = this.applied.get(mesh);
        if (!applied || applied.retargeting || this.released) return;
        if (mesh.material === applied.variant) return;
        // Render-mode swaps and late material applies re-wrap around the new
        // source; the bake keeps its receiver instead of silently reverting.
        this.retire(mesh, applied);
        this.applied.delete(mesh);
        this.wrap(mesh, applied.binding, applied.sources, applied.lightForSource);
      }),
      retargeting: false,
    };
    if (variant) {
      for (const contribution of receiver.contributions) {
        // Only sources whose direct term is baked in are excluded; indirectOnly
        // keeps realtime direct and unlisted sources stay untouched.
        if (contribution.term !== "directAndIndirect") continue;
        const lightSource = sources.get(contribution.sourceId);
        if (!lightSource || lightSource.kind !== "light") continue;
        const light = lightForSource(lightSource);
        // Play/player light visuals spawn via snapshot assignMesh after the
        // bake applies; keep the source pending so a later sync excludes it.
        if (!light) {
          entry.pendingExclusions.push(lightSource);
          continue;
        }
        if (!light.excludedMeshes.includes(mesh)) {
          light.excludedMeshes.push(mesh);
          entry.excludedLights.push(light);
        }
      }
    }
    this.applied.set(mesh, entry);
    if (!variant) return null;
    entry.retargeting = true;
    try {
      mesh.material = variant;
    } finally {
      entry.retargeting = false;
    }
    return variant;
  }

  /**
   * Readiness-probe maintenance: CEL adapters mirror their live source, a
   * receiver whose variant was replaced without notification is re-wrapped,
   * and exclusions removed by another owner are re-applied.
   */
  sync(): void {
    if (this.released) return;
    for (const [mesh, entry] of this.applied) {
      if (entry.variant instanceof CelMaterial) entry.variant.syncSource();
      if (entry.variant === null) {
        // The material that failed to consume the bake stays in place; retry
        // only once a different material replaces it.
        if (mesh.material !== entry.original) {
          this.retire(mesh, entry);
          this.applied.delete(mesh);
          this.wrap(mesh, entry.binding, entry.sources, entry.lightForSource);
        }
        continue;
      }
      if (mesh.material !== entry.variant) {
        this.retire(mesh, entry);
        this.applied.delete(mesh);
        this.wrap(mesh, entry.binding, entry.sources, entry.lightForSource);
        continue;
      }
      this.refreshExclusions(mesh, entry);
    }
  }

  private refreshExclusions(mesh: Mesh, entry: AppliedReceiver): void {
    if (entry.pendingExclusions.length) {
      entry.pendingExclusions = entry.pendingExclusions.filter((source) => {
        const light = entry.lightForSource(source);
        if (!light) return true;
        if (!light.excludedMeshes.includes(mesh)) {
          light.excludedMeshes.push(mesh);
        }
        if (!entry.excludedLights.includes(light)) {
          entry.excludedLights.push(light);
        }
        return false;
      });
    }
    for (const light of entry.excludedLights) {
      if (light.isDisposed()) continue;
      if (!light.excludedMeshes.includes(mesh)) {
        light.excludedMeshes.push(mesh);
      }
    }
  }

  private retire(mesh: Mesh, entry: AppliedReceiver): void {
    entry.observer.remove();
    if (entry.variant && mesh.material === entry.variant) {
      entry.retargeting = true;
      try {
        mesh.material = entry.original;
      } finally {
        entry.retargeting = false;
      }
    }
    for (const light of entry.excludedLights) {
      const index = light.excludedMeshes.indexOf(mesh);
      if (index >= 0) light.excludedMeshes.splice(index, 1);
    }
    entry.variant?.dispose(false, false);
  }

  /** Per-receiver material and compiled-define readout for session diagnostics. */
  diagnostics(): Array<{
    mesh: string;
    material: string | null;
    slateBaked: boolean;
    excludedLights: string[];
    lightDefines: number | null;
  }> {
    return [...this.applied].map(([mesh, entry]) => {
      const defines = mesh.subMeshes
        .flatMap((subMesh) => {
          // `subMesh.effect` resolves only the current render pass's draw
          // wrapper; Play/player frames can leave a different pass current, so
          // scan every compiled wrapper, preferring the current pass's effect.
          const wrappers =
            (
              subMesh as {
                _drawWrappers?: readonly ({
                  effect?: { defines?: unknown } | null;
                } | null)[];
              }
            )._drawWrappers ?? [];
          return [
            subMesh.effect?.defines,
            ...wrappers.map((wrapper) => wrapper?.effect?.defines),
          ]
            .map((defines) => String(defines ?? ""))
            .filter((defines) => defines.length > 0);
        })
        .join("\n");
      return {
        mesh: mesh.name,
        material: entry.variant?.name ?? null,
        // A compiled effect's defines are ground truth once the receiver has
        // rendered; before the first compile, report whether the bound
        // variant is configured to emit the baked path.
        slateBaked: defines.length
          ? /\bSLATE_BAKED\b/.test(defines)
          : variantCarriesBake(entry.variant),
        excludedLights: entry.excludedLights.map((light) => light.name),
        // Realtime light defines on the compiled receiver effect; null until
        // an effect exists so the count cannot be mistaken for zero.
        lightDefines: defines.length
          ? (defines.match(/#define (?:DIR|POINT|SPOT|HEMI)LIGHT\d+/g) ?? [])
              .length
          : null,
      };
    });
  }

  /** Restore every receiver's original material and exclusion lists. */
  release(): void {
    if (this.released) return;
    this.released = true;
    const failures: unknown[] = [];
    for (const [mesh, entry] of this.applied) {
      try {
        this.retire(mesh, entry);
      } catch (error) {
        failures.push(error);
      }
    }
    this.applied.clear();
    if (failures.length)
      throw new AggregateError(
        failures,
        "Baked receiver material release failed.",
      );
  }
}
