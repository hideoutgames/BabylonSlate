import {
  Constants,
  CubeTexture,
  Material,
  Matrix,
  Quaternion,
  RenderTargetTexture,
  Texture,
  Vector3,
  type AbstractMesh,
  type Node,
  type Scene,
  type TransformNode,
  type UniformBuffer,
} from "@babylonjs/core";
import {
  reflectionProbeBindings,
  reflectionProbeStaticActors,
  type ReflectionProbeBinding,
  type ReflectionProbeProperties,
  type SerializedScene,
} from "@haptic/core";
import { drawBorrowedTarget } from "./framegraph-borrowed-draw";
import { environmentPolynomial } from "./environment-irradiance";
import { createFilteredEnvironmentTarget, filterEnvironment, type FilteredEnvironmentTarget } from "./environment-prefilter";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";
import { setMeshEnvironmentResolver } from "./mesh-environment";
import { drawOutsideSceneView } from "./render-target-capture";
import { isRenderTargetCaptureCandidate } from "./render-target-capture-state";
import { isMirrorSurfaceMesh } from "./mirror-surface-state";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { admittedSceneMeshes } from "./scene-stream-admission";
import { isSkyboxMesh } from "./skybox";

/** Edits and mesh changes settle this long before probes recapture, so a drag recaptures once. */
export const REFLECTION_PROBE_RECAPTURE_DELAY_MS = 750;
const NEAR = 0.05;

type CaptureTarget = {
  texture: RenderTargetTexture;
  lease: ManagedRenderLease;
  filtered: FilteredEnvironmentTarget;
  /** What materials sample: the filtered cube, box-projected onto the probe's volume. */
  view: CubeTexture;
  sceneUbos: UniformBuffer[];
};

type Probe = {
  actorId: string;
  id: string;
  properties: ReflectionProbeProperties;
  /** Unit box (extent 1) to actor local. */
  local: Matrix;
  root: TransformNode;
  /** World-space axis-aligned box of the probe volume; box projection is axis-aligned. */
  min: Vector3;
  max: Vector3;
  volume: number;
  target?: CaptureTarget;
  published: boolean;
  /** Static-mesh set this probe last captured; an unchanged set skips a recapture. */
  captured: string;
  /** A capture or filter is in flight; another waits for it. */
  busy: boolean;
  failed: boolean;
};

type Assignment = { x: number; y: number; z: number; generation: number; view: CubeTexture | null };

const controllers = new WeakMap<Scene, ReflectionProbes>();
const faceTargets = [
  new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, -1, 0),
  new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1),
];

function captureBytes(size: number): number {
  let colour = 0;
  for (let face = size; face >= 1; face >>= 1) colour += face * face * 6 * 8;
  return colour + size * size * 6 * 4;
}

/**
 * A scene's reflection probes: each captures the scene's static meshes into a
 * cube, filters it like the sky, and lights the surfaces inside its box.
 */
export class ReflectionProbes {
  private readonly scene: Scene;
  private readonly probes = new Map<string, Probe[]>();
  private isStatic: (mesh: AbstractMesh) => boolean = () => false;
  private readonly assignments = new WeakMap<AbstractMesh, Assignment>();
  /** Bumped whenever the published set changes, invalidating every assignment. */
  private generation = 0;
  private capturing = false;
  private dirtyAt = -1;
  private disposed = false;
  private authored: SerializedScene | null = null;
  private readonly world = Matrix.Identity();
  private readonly part = Matrix.Identity();
  private readonly corner = new Vector3();
  private readonly position = new Vector3();
  private readonly lookAt = new Vector3();
  private readonly viewMatrix = Matrix.Identity();
  private readonly beforeRender = () => this.update();
  private readonly meshesChanged = () => this.markDirty();

  constructor(scene: Scene) {
    this.scene = scene;
    scene.onBeforeRenderObservable.add(this.beforeRender);
    scene.onNewMeshAddedObservable.add(this.meshesChanged);
    scene.onMeshRemovedObservable.add(this.meshesChanged);
    scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  /** Which meshes a capture records; the host knows actors, the renderer only meshes. */
  setStaticPredicate(predicate: (mesh: AbstractMesh) => boolean): void {
    this.isStatic = predicate;
    this.markDirty();
  }

  upsert(actorId: string, root: TransformNode, bindings: readonly ReflectionProbeBinding[]): void {
    const previous = new Map((this.probes.get(actorId) ?? []).map((probe) => [probe.id, probe]));
    const next: Probe[] = [];
    for (const binding of bindings) {
      if (binding.error || !binding.properties.enabled) continue;
      const kept = previous.get(binding.id);
      const local = Matrix.Scaling(binding.properties.size[0] / 2, binding.properties.size[1] / 2, binding.properties.size[2] / 2);
      for (const transform of binding.transforms) {
        Matrix.ComposeToRef(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation),
          Vector3.FromArray(transform.position), this.part);
        local.multiplyToRef(this.part, local);
      }
      const resized = kept && kept.properties.resolution !== binding.properties.resolution;
      if (kept && !resized) {
        previous.delete(binding.id);
        kept.properties = binding.properties;
        kept.local = local;
        kept.root = root;
        kept.captured = "";
        next.push(kept);
        continue;
      }
      next.push({
        actorId, id: binding.id, properties: binding.properties, local, root,
        min: new Vector3(), max: new Vector3(), volume: 0, published: false, captured: "", busy: false, failed: false,
      });
    }
    for (const probe of previous.values()) this.retire(probe);
    if (next.length) this.probes.set(actorId, next); else this.probes.delete(actorId);
    this.markDirty();
    this.republish();
  }

  remove(actorId: string): void {
    const probes = this.probes.get(actorId);
    if (!probes) return;
    this.probes.delete(actorId);
    for (const probe of probes) this.retire(probe);
    this.republish();
  }

  clear(): void {
    for (const actorId of [...this.probes.keys()]) this.remove(actorId);
  }

  /**
   * Editor scenes: probes and static actors from the authored document. Any
   * document change recaptures once the editing settles.
   */
  syncAuthored(data: SerializedScene): void {
    if (data === this.authored) return;
    this.authored = data;
    const statics = reflectionProbeStaticActors(data.actors);
    this.setStaticPredicate((mesh) => {
      for (let node: Node | null = mesh; node; node = node.parent) {
        if (node.name.startsWith("editorActor:")) return statics.has(node.name.slice("editorActor:".length));
      }
      return false;
    });
    const live = new Set<string>();
    for (const actor of data.actors) {
      const bindings = actor.visible ? reflectionProbeBindings(actor.components) : [];
      const root = bindings.length ? this.scene.getMeshByName(`editorActor:${actor.id}`) : null;
      if (!root) continue;
      this.upsert(actor.id, root, bindings);
      live.add(actor.id);
    }
    for (const actorId of [...this.probes.keys()]) if (!live.has(actorId)) this.remove(actorId);
    this.markDirty(true);
  }

  /** Recapture after the scene settles. `force` recaptures even when no static mesh changed. */
  markDirty(force = false): void {
    if (this.disposed) return;
    if (force) for (const probes of this.probes.values()) for (const probe of probes) { probe.captured = ""; probe.failed = false; }
    this.dirtyAt = performance.now();
  }

  /** Probe states, in registration order. */
  diagnostics(): Array<{ actorId: string; id: string; published: boolean; resolution: number; min: number[]; max: number[] }> {
    return [...this.probes.values()].flat().map((probe) => ({
      actorId: probe.actorId, id: probe.id, published: probe.published, resolution: probe.properties.resolution,
      min: probe.min.asArray(), max: probe.max.asArray(),
    }));
  }

  /** The probe cube `mesh` reflects, or null for the scene's own environment. */
  private resolve(mesh: AbstractMesh): CubeTexture | null {
    if (this.capturing || mesh.infiniteDistance || isSkyboxMesh(mesh)) return null;
    const center = mesh.getBoundingInfo().boundingSphere.centerWorld;
    const cached = this.assignments.get(mesh);
    if (cached && cached.generation === this.generation && cached.x === center.x && cached.y === center.y && cached.z === center.z) return cached.view;
    let best: Probe | undefined;
    for (const probes of this.probes.values()) for (const probe of probes) {
      if (!probe.published || probe.volume >= (best?.volume ?? Infinity)) continue;
      if (center.x < probe.min.x || center.y < probe.min.y || center.z < probe.min.z ||
        center.x > probe.max.x || center.y > probe.max.y || center.z > probe.max.z) continue;
      best = probe;
    }
    const view = best?.target?.view ?? null;
    if (cached && cached.view !== view) this.invalidateMesh(mesh);
    this.assignments.set(mesh, { x: center.x, y: center.y, z: center.z, generation: this.generation, view });
    return view;
  }

  /** A mesh that changes cube may need other defines (format, box projection): rebuild its material's. */
  private invalidateMesh(mesh: AbstractMesh): void {
    const material = mesh.material;
    if (!material) return;
    const blocked = this.scene.blockMaterialDirtyMechanism;
    this.scene.blockMaterialDirtyMechanism = false;
    try {
      material.markAsDirty(Material.TextureDirtyFlag);
      material.markDirty(true);
    } finally {
      this.scene.blockMaterialDirtyMechanism = blocked;
    }
    markSceneReadinessDirty(this.scene);
  }

  private republish(): void {
    this.generation++;
    const any = [...this.probes.values()].some((probes) => probes.some((probe) => probe.published));
    setMeshEnvironmentResolver(this.scene, any ? (mesh) => this.resolve(mesh) : null);
    markSceneReadinessDirty(this.scene);
  }

  private update(): void {
    if (this.disposed || this.capturing || !this.probes.size) return;
    for (const probes of this.probes.values()) for (const probe of probes) this.place(probe);
    if (this.dirtyAt < 0 || performance.now() - this.dirtyAt < REFLECTION_PROBE_RECAPTURE_DELAY_MS) return;
    // One capture per frame: six draws of the static scene are the CPU cost.
    const signature = this.staticSignature();
    let pending = false;
    for (const probes of this.probes.values()) for (const probe of probes) {
      if (probe.busy) { pending = true; continue; }
      if (probe.failed || probe.captured === signature) continue;
      this.capture(probe, signature);
      return;
    }
    if (!pending) this.dirtyAt = -1;
  }

  /** The probe's world box from its actor's current pose. */
  private place(probe: Probe): void {
    probe.local.multiplyToRef(probe.root.computeWorldMatrix(), this.world);
    probe.min.setAll(Infinity);
    probe.max.setAll(-Infinity);
    for (let i = 0; i < 8; i++) {
      Vector3.TransformCoordinatesFromFloatsToRef(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, this.world, this.corner);
      probe.min.minimizeInPlace(this.corner);
      probe.max.maximizeInPlace(this.corner);
    }
    const size = probe.max.subtract(probe.min);
    const volume = size.x * size.y * size.z;
    const target = probe.target;
    if (target && (probe.volume !== volume || !target.view.boundingBoxPosition.equalsWithEpsilon(this.corner.copyFrom(probe.min).addInPlace(probe.max).scaleInPlace(0.5), 0))) {
      target.view.boundingBoxPosition = this.corner.clone();
      target.view.boundingBoxSize = size;
      if (probe.published) this.generation++;
    }
    probe.volume = volume;
  }

  private staticSignature(): string {
    const ids: number[] = [];
    for (const mesh of admittedSceneMeshes(this.scene) ?? this.scene.meshes) if (this.eligible(mesh)) ids.push(mesh.uniqueId);
    return ids.join(",");
  }

  private eligible(mesh: AbstractMesh): boolean {
    if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0 || mesh.getTotalVertices() === 0) return false;
    if (!isRenderTargetCaptureCandidate(mesh)) return false;
    if ((mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true) return false;
    // A Mirror shows a reflection drawn for the current view; a probe would bake it in from the wrong place.
    if (isMirrorSurfaceMesh(mesh)) return false;
    return this.isStatic(mesh);
  }

  private ensureTarget(probe: Probe): CaptureTarget | null {
    if (probe.target) return probe.target;
    const engine = this.scene.getEngine();
    const size = probe.properties.resolution;
    const bytes = captureBytes(size);
    const lease = beginManagedRenderAllocation(engine, bytes);
    if (!lease) return null;
    let filtered: FilteredEnvironmentTarget | null = null;
    let texture: RenderTargetTexture | undefined;
    try {
      filtered = createFilteredEnvironmentTarget(engine, size);
      if (!filtered) { void releaseManagedRenderLeaseAfterDisposal(engine, lease); return null; }
      texture = new RenderTargetTexture(`reflectionProbe:${probe.actorId}:${probe.id}`, size, this.scene, {
        generateMipMaps: true, isCube: true, doNotChangeAspectRatio: true,
        type: engine.getCaps().textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE,
        samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      });
      // Captured display-referred, like a Fast Render Target Capture; the filter decodes it.
      texture.gammaSpace = true;
      texture.clearColor = this.scene.clearColor;
      texture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      lease.commit([{ handle: texture.getInternalTexture()!, bytes, category: "environment" }]);
      const view = filtered.cube.clone();
      filtered.target.texture!.incrementReferences();
      view._texture = filtered.target.texture;
      view.gammaSpace = false;
      view.lodGenerationScale = filtered.cube.lodGenerationScale;
      view.lodGenerationOffset = filtered.cube.lodGenerationOffset;
      view._prefiltered = true;
      view.coordinatesMode = Texture.CUBIC_MODE;
      view.boundingBoxSize = probe.max.subtract(probe.min);
      view.boundingBoxPosition = probe.min.add(probe.max).scaleInPlace(0.5);
      const sceneUbos = engine.supportsUniformBuffers
        ? Array.from({ length: 6 }, (_, face) => this.scene.createSceneUniformBuffer(`Reflection Probe ${probe.id} face ${face}`, { forceMono: true }))
        : [];
      probe.target = { texture, lease, filtered, view, sceneUbos };
      this.bindFaces(probe, probe.target);
      return probe.target;
    } catch (error) {
      texture?.dispose();
      filtered?.release();
      void releaseManagedRenderLeaseAfterDisposal(engine, lease);
      throw error;
    }
  }

  /** Each face looks along its axis from the probe's centre (Babylon's ReflectionProbe convention). */
  private bindFaces(probe: Probe, target: CaptureTarget): void {
    const scene = this.scene;
    target.texture.onBeforeRenderObservable.add((face) => {
      if (target.sceneUbos.length) {
        scene.setSceneUniformBuffer(target.sceneUbos[face]!);
        scene.getSceneUniformBuffer().unbindEffect();
      }
      const center = this.position.copyFrom(probe.min).addInPlace(probe.max).scaleInPlace(0.5);
      center.addToRef(faceTargets[face]!, this.lookAt);
      Matrix.LookAtLHToRef(center, this.lookAt, Vector3.Up(), this.viewMatrix);
      const camera = scene.activeCamera;
      const far = Math.max(camera?.maxZ ?? 1000, 1000);
      const engine = scene.getEngine();
      const projection = Matrix.PerspectiveFovLH(Math.PI / 2, 1, engine.useReverseDepthBuffer ? far : NEAR,
        engine.useReverseDepthBuffer ? NEAR : far, engine.isNDCHalfZRange);
      scene.setTransformMatrix(this.viewMatrix, projection);
      if (target.sceneUbos.length) scene.finalizeSceneUbo();
      scene._forcedViewPosition = center;
    });
    target.texture.onAfterUnbindObservable.add(() => { scene._forcedViewPosition = null; });
  }

  private capture(probe: Probe, signature: string): void {
    const target = this.ensureTarget(probe);
    if (!target) { probe.failed = true; return; }
    const meshes: AbstractMesh[] = [];
    for (const mesh of admittedSceneMeshes(this.scene) ?? this.scene.meshes) if (this.eligible(mesh)) meshes.push(mesh);
    target.texture.renderList = meshes;
    let drawn: boolean;
    this.capturing = true;
    try {
      drawn = drawOutsideSceneView(this.scene, () => {
        let ready = false;
        drawBorrowedTarget(this.scene, target.texture, () => {
          const engine = this.scene.getEngine();
          engine.setAlphaMode(Constants.ALPHA_DISABLE);
          engine.setDepthBuffer(true);
          engine.setDepthWrite(true);
          engine.setColorWrite(true);
          ready = target.texture.isReadyForRendering();
          if (ready) target.texture.render(false);
        }, { restoreAlpha: true, wrapDrawFailure: false, message: "Reflection probe capture failed." });
        return ready;
      }, true);
    } catch (error) {
      probe.failed = true;
      console.warn(`[render] Reflection probe ${probe.id} capture failed: ${String(error)}`);
      return;
    } finally {
      this.capturing = false;
    }
    // Not ready yet (materials or textures still loading): try again next frame.
    if (!drawn) return;
    probe.busy = true;
    const engine = this.scene.getEngine();
    const current = () => !this.disposed && probe.target === target;
    void filterEnvironment(engine, target.texture, target.filtered)
      .then(() => current() ? environmentPolynomial(target.filtered.cube, current, { rgbd: false, gamma: false, exactSrgb: false }) : null)
      .then((polynomial) => {
        if (!current()) return;
        target.filtered.target.texture!._sphericalPolynomial = polynomial;
        probe.captured = signature;
        const first = !probe.published;
        probe.published = true;
        if (first) this.republish();
        else markSceneReadinessDirty(this.scene);
      }, (error: unknown) => {
        if (!current()) return;
        probe.failed = true;
        console.warn(`[render] Reflection probe ${probe.id} filtering failed: ${String(error)}`);
      })
      .finally(() => { probe.busy = false; });
  }

  private retire(probe: Probe): void {
    const target = probe.target;
    probe.target = undefined;
    probe.published = false;
    if (!target) return;
    target.view.dispose();
    target.texture.dispose();
    for (const ubo of target.sceneUbos) ubo.dispose();
    target.filtered.release();
    void releaseManagedRenderLeaseAfterDisposal(this.scene.getEngine(), target.lease);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.onBeforeRenderObservable.removeCallback(this.beforeRender);
    this.scene.onNewMeshAddedObservable.removeCallback(this.meshesChanged);
    this.scene.onMeshRemovedObservable.removeCallback(this.meshesChanged);
    for (const probes of this.probes.values()) for (const probe of probes) this.retire(probe);
    this.probes.clear();
    setMeshEnvironmentResolver(this.scene, null);
    controllers.delete(this.scene);
  }
}

export function sceneReflectionProbes(scene: Scene): ReflectionProbes {
  let controller = controllers.get(scene);
  if (!controller) { controller = new ReflectionProbes(scene); controllers.set(scene, controller); }
  return controller;
}

export function findSceneReflectionProbes(scene: Scene): ReflectionProbes | undefined {
  return controllers.get(scene);
}
