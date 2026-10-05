import {
  ShadowDepthWrapper, type AbstractMesh, type DrawWrapper, type Effect, type Node, type NodeMaterial,
  type Observer, type ShadowGenerator, type SubMesh,
} from "@babylonjs/core";
import { retireOwnedEffect, type OwnedEffectRetirement } from "./owned-effect-retirement";

/** Pinned Babylon 9.20 ownership adapter: dispose() only detaches observers.
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
    if (this.released) return false;
    for (const retirement of this.retirements) if (retirement.isReleased()) this.retirements.delete(retirement);
    const entries = this.native._subMeshToDepthWrapper.mm.get(subMesh);
    const previous = entries?.get(generator);
    // Upstream overwrites its main Effect on a light/filter permutation change.
    // End that owned reference before creating the replacement generation.
    if (previous && previous.depthDefines !== defines.join("\n")) {
      this.retireEntry(subMesh, previous); entries!.delete(generator);
    }
    return super.isReadyForSubMesh(subMesh, defines, generator, instances, passId);
  }
  private retireEntry(subMesh: SubMesh | null, entry: NativeShadowEntry): void {
    const effect = entry.mainDrawWrapper.effect;
    const wrappers = new Set([entry.mainDrawWrapper, ...entry.drawWrapper.filter((value): value is DrawWrapper => value != null)]);
    if (effect) subMesh?.getRenderingMesh().geometry?._releaseVertexArrayObject(effect);
    for (const wrapper of wrappers) { wrapper.setEffect(null); wrapper.dispose(true); }
    this.retirements.add(retireOwnedEffect(effect, () => effect?.dispose()));
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
