import { Mesh, SubMesh, type AbstractMesh, type Light, type Material, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { clusteredSceneMaterialReason } from "./clustered-material-policy";
import { withSceneReadinessState } from "./scene-perf";

type Probe = { mesh: AbstractMesh; source: SubMesh; part: SubMesh; material: Material; instances: boolean; pass: number; ready: boolean };
type Work = {
  key: string;
  camera: Scene["activeCamera"];
  layout: ReadonlyMap<Light, ShadowGenerator | null>;
  current: () => boolean;
  probes: Probe[];
  next: number;
  remaining: number;
  committed: boolean;
  failed: boolean;
  started: number;
};

/** One prospective receiver layout. No extra shadow RTTs or live submesh writes. */
export class ShadowReceiverWarmup {
  private work: Work | undefined;
  private probing = false;
  private readonly retired: Work[] = [];
  constructor(private readonly scene: Scene) {}

  ready(key: string, layout: ReadonlyMap<Light, ShadowGenerator | null>, passes: readonly number[], current: () => boolean): boolean {
    if (this.work?.key === key) return this.work.remaining === 0 || this.work.failed;
    this.cancel();
    // Reuse the engine's qualified native/compiled light-material contract.
    // Unknown shader callbacks and unsupported native extensions keep normal readiness.
    if (clusteredSceneMaterialReason(this.scene)) return true;
    const work: Work = { key, camera: this.scene.activeCamera, layout, current, probes: [], next: 0, remaining: 0, committed: false, failed: false, started: performance.now() };
    this.work = work;
    for (const mesh of this.scene.meshes) {
      if (!mesh.receiveShadows || mesh.isDisposed() || !mesh.getTotalVertices()) continue;
      const instanced = mesh.hasThinInstances || mesh.isAnInstance;
      const variants = instanced ? [true] : mesh instanceof Mesh && mesh.instances.length ? [false, true] : [false];
      for (const source of mesh.subMeshes ?? []) {
        const material = source.getMaterial();
        if (!material?._storeEffectOnSubMeshes) continue;
        for (const pass of new Set(passes)) for (const instances of variants) {
          const part = new SubMesh(source.materialIndex, source.verticesStart, source.verticesCount,
            source.indexStart, source.indexCount, mesh, source.getRenderingMesh(), false, false);
          work.probes.push({ mesh, source, part, material, pass, instances, ready: false });
        }
      }
    }
    work.remaining = work.probes.length;
    return work.remaining === 0;
  }

  /** Called after a frame using the incumbent layout; never holds a scope across a yield. */
  advance(): void {
    const work = this.work;
    if (!work || work.committed || work.failed || work.remaining === 0) return;
    if (performance.now() - work.started > 10_000) { work.failed = true; return; }
    if (this.scene.isDisposed || this.scene.activeCamera !== work.camera || !work.current()) { this.cancel(); return; }
    const until = performance.now() + 2;
    // Bound dispatch as well as elapsed time. An individual driver call cannot
    // be preempted; asynchronous shader completion is polled on later frames.
    for (let count = 0; count < 8 && performance.now() < until && work.remaining; count++) {
      let probe = work.probes[work.next++ % work.probes.length]!;
      while (probe.ready) probe = work.probes[work.next++ % work.probes.length]!;
      if (probe.mesh.isDisposed() || !probe.mesh.subMeshes.includes(probe.source) || probe.source.getMaterial() !== probe.material) {
        this.cancel(); return;
      }
      try {
        const ready = this.probe(work, probe);
        if (this.work !== work || !work.current()) { this.cancel(); return; }
        if (ready) { probe.ready = true; work.remaining--; }
      } catch {
        // The normal admission/readiness path remains the error authority.
        work.failed = true;
        return;
      }
    }
  }

  private probe(work: Work, probe: Probe): boolean {
    const restored: (() => void)[] = [];
    const material = probe.material;
    const flags = [material.allowShaderHotSwapping, material.checkReadyOnEveryCall, material.checkReadyOnlyOnce] as const;
    this.probing = true;
    try {
      for (const [light, generator] of work.layout) {
        const descriptor = Object.getOwnPropertyDescriptor(light, "getShadowGenerator");
        const lookup = () => generator;
        Object.defineProperty(light, "getShadowGenerator", { value: lookup, configurable: true, writable: true });
        restored.push(() => {
          if (light.getShadowGenerator !== lookup) return;
          if (descriptor) Object.defineProperty(light, "getShadowGenerator", descriptor);
          else Reflect.deleteProperty(light, "getShadowGenerator");
        });
      }
      material.allowShaderHotSwapping = false;
      material.checkReadyOnEveryCall = true;
      material.checkReadyOnlyOnce = false;
      return withSceneReadinessState(this.scene, () => {
        this.scene.getEngine().currentRenderPassId = probe.pass;
        const ready = material.isReadyForSubMesh(probe.mesh, probe.part, probe.instances);
        if (probe.part.effect?.getCompilationError()) throw new Error("Prospective shadow receiver compilation failed.");
        return ready;
      });
    } finally {
      [material.allowShaderHotSwapping, material.checkReadyOnEveryCall, material.checkReadyOnlyOnce] = flags;
      for (const restore of restored.reverse()) restore();
      this.probing = false;
      for (const retired of this.retired.splice(0)) this.release(retired);
    }
  }

  /** Retain effect references until strict readiness installs them on real parts. */
  commit(): void { if (this.work) this.work.committed = true; }
  releaseCommitted(): void { if (this.work?.committed) this.cancel(); }
  cancelPending(): void { if (!this.work?.committed) this.cancel(); }
  cancel(): void {
    const work = this.work;
    this.work = undefined;
    if (!work) return;
    if (this.probing) this.retired.push(work);
    else this.release(work);
  }
  private release(work: Work): void {
    // Babylon 9.20 SubMesh.dispose splices mesh.subMeshes even for detached
    // parts (index -1). Release only their owned draw contexts and effect refs.
    for (const probe of work.probes) probe.part.resetDrawCache(undefined, true);
  }
}
