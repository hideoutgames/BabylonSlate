import {
  ShadowDepthWrapper, type AbstractMesh, type BaseTexture, type DrawWrapper, type Effect, type Node, type NodeMaterial,
  type Observer, type RenderTargetTexture, type ShadowGenerator, type SubMesh,
} from "@babylonjs/core";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";

/** Pinned Babylon 9.29 ownership adapter: dispose() only detaches observers.
 * Its per-generator wrappers borrow one Effect reference from the main wrapper.
 * Retire that reference once, after native parallel compilation has settled. */
type NativeShadowEntry = { mainDrawWrapper: DrawWrapper; drawWrapper: Array<DrawWrapper | null>; depthDefines: string };
type NativeShadowResources = {
  _subMeshToDepthWrapper: { mm: Map<SubMesh | null, Map<ShadowGenerator, NativeShadowEntry>> };
  _subMeshToEffect: Map<SubMesh | null, [Effect, number]>;
};

export class AuthoredShadowDepthWrapper extends ShadowDepthWrapper {
  private released: Promise<void> | undefined;
  private readonly retirements = new Set<OwnedEffectRetirement>();
  private readonly meshObservers = new Map<AbstractMesh, Observer<Node>>();
  /** ShadowGenerator.dispose never reaches the materials its map drew; its shadow map's disposal ends the generator's entries. */
  private readonly mapObservers = new Map<ShadowGenerator, { map: RenderTargetTexture; observer: Observer<BaseTexture> }>();
  private readonly effectObserver: Observer<{ effect: Effect; subMesh: SubMesh | null }>;
  private get native(): NativeShadowResources { return this as unknown as NativeShadowResources; }
  constructor(material: NodeMaterial) {
    super(material, material.getScene(), { standalone: true, doNotInjectCode: true });
    // Run before Babylon's observer, which otherwise synchronously disposes
    // the replaced program while parallel compilation can still reference it.
    this.effectObserver = material.onEffectCreatedObservable.add(({ effect, subMesh }) => {
      if (this.native._subMeshToEffect.get(subMesh)?.[0] !== effect) this.retireSubMesh(subMesh);
      const mesh = subMesh?.getMesh();
      if (mesh && !this.meshObservers.has(mesh)) this.meshObservers.set(mesh, mesh.onDisposeObservable.add(() => {
        for (const key of this.native._subMeshToDepthWrapper.mm.keys()) if (key?.getMesh() === mesh) this.retireSubMesh(key);
        this.meshObservers.delete(mesh);
      }, -1, true));
    }, -1, true);
  }
  override isReadyForSubMesh(subMesh: SubMesh, defines: string[], generator: ShadowGenerator, instances: boolean, passId: number): boolean {
    // A disposed generator has no map to observe; it must not create an entry nobody retires.
    if (this.released || !generator.getShadowMap()) return false;
    this.pruneRetirements();
    const entries = this.native._subMeshToDepthWrapper.mm.get(subMesh);
    const previous = entries?.get(generator);
    // Upstream overwrites its main Effect on a light/filter permutation change.
    // End that owned reference before creating the replacement generation.
    if (previous && previous.depthDefines !== defines.join("\n")) {
      this.retireEntry(subMesh, previous); entries!.delete(generator);
    }
    const ready = super.isReadyForSubMesh(subMesh, defines, generator, instances, passId);
    if (!this.mapObservers.has(generator) && this.native._subMeshToDepthWrapper.mm.get(subMesh)?.has(generator)) this.observeShadowMap(generator);
    return ready;
  }
  private pruneRetirements(): void {
    for (const retirement of this.retirements) if (retirement.isReleased()) this.retirements.delete(retirement);
  }
  /** The map disposes with its generator, or when the generator recreates it (the old map's pass ids are then dead). */
  private observeShadowMap(generator: ShadowGenerator): void {
    const map = generator.getShadowMap();
    if (map) this.mapObservers.set(generator, { map, observer: map.onDisposeObservable.addOnce(() => this.retireGenerator(generator)) });
  }
  private retireGenerator(generator: ShadowGenerator): void {
    this.mapObservers.delete(generator);
    this.pruneRetirements();
    const subMeshes = this.native._subMeshToDepthWrapper.mm;
    for (const [subMesh, entries] of subMeshes) {
      const entry = entries.get(generator);
      if (!entry) continue;
      this.retireEntry(subMesh, entry); entries.delete(generator);
      if (!entries.size) subMeshes.delete(subMesh);
    }
  }
  private retireEntry(subMesh: SubMesh | null, entry: NativeShadowEntry): void {
    const effect = entry.mainDrawWrapper.effect;
    const geometry = subMesh?.getRenderingMesh().geometry;
    const wrappers = new Set([entry.mainDrawWrapper, ...entry.drawWrapper.filter((value): value is DrawWrapper => value != null)]);
    for (const wrapper of wrappers) { wrapper.setEffect(null); wrapper.dispose(true); }
    this.retirements.add(retireOwnedEffect(effect, () => {
      effect?.dispose();
      // A shared Effect keeps the vertex array object its remaining entries bind.
      if (effect?.isDisposed) geometry?._releaseVertexArrayObject(effect);
    }));
  }
  private retireSubMesh(subMesh: SubMesh | null): void {
    const entries = this.native._subMeshToDepthWrapper.mm.get(subMesh);
    if (!entries) return;
    for (const entry of entries.values()) this.retireEntry(subMesh, entry);
    this.native._subMeshToDepthWrapper.mm.delete(subMesh);
  }
  override dispose(): void {
    if (this.released) return;
    this.baseMaterial.onEffectCreatedObservable.remove(this.effectObserver);
    for (const [mesh, observer] of this.meshObservers) mesh.onDisposeObservable.remove(observer);
    this.meshObservers.clear();
    for (const { map, observer } of this.mapObservers.values()) map.onDisposeObservable.remove(observer);
    this.mapObservers.clear();
    super.dispose();
    for (const subMesh of this.native._subMeshToDepthWrapper.mm.keys()) this.retireSubMesh(subMesh);
    // Standalone NodeMaterial readiness creates a separate base program in the
    // shadow pass. The visible source material does not own that program.
    for (const [subMesh, [effect, passId]] of this.native._subMeshToEffect) {
      const draw = subMesh?._getDrawWrapper(passId);
      if (!draw || draw.effect !== effect) continue;
      draw.setEffect(null);
      subMesh!._removeDrawWrapper(passId);
      subMesh!.getRenderingMesh().geometry?._releaseVertexArrayObject(effect);
      this.retirements.add(retireOwnedEffect(effect, () => effect.dispose()));
    }
    this.native._subMeshToEffect.clear();
    this.released = Promise.all([...this.retirements].map((retirement) => retirement.released)).then(() => { this.retirements.clear(); });
  }
  whenReleased(): Promise<void> { this.dispose(); return this.released!; }
}
