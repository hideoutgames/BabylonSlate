import type { AbstractMesh, Material, Observable, Plane, Scene } from "@babylonjs/core";
import { Camera, Constants, Frustum, Matrix } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";
import { pickCandidates } from "./gpu-pick-candidates";
import { onSceneReadinessDirty } from "./scene-readiness-signal";

/** Mesh hit by a GPU pick; `null` is background, `undefined` means use CPU picking. */
export type GpuPickResult = AbstractMesh | null | undefined;

const READY_TIMEOUT_MS = 1000;
const READY_POLL_MS = 16;
const PICK_TARGET_SIZE = { width: 1, height: 1 } as const;

/** Same eligibility as Babylon's default `scene.pick` predicate. */
export function gpuPickableMeshes(scene: Scene): AbstractMesh[] {
  return scene.meshes.filter(
    (mesh) => mesh.isPickable && mesh.isVisible && mesh.isEnabled() && mesh.getTotalVertices() > 0,
  );
}

/** Decode the RGB 24-bit id written by Babylon's `encodeObjectId`. */
export function decodeObjectId(pixel: ArrayLike<number>): number {
  return ((pixel[0] ?? 0) << 16) | ((pixel[1] ?? 0) << 8) | (pixel[2] ?? 0);
}

/**
 * Narrow `projection` to pixel (`px`, `py`) of a top-down `width` × `height`
 * view: clip x/y are scaled and shifted in proportion to w, so that pixel's
 * centre lands on the centre of a 1×1 target. Depth and the sample position
 * are unchanged, so the single texel matches that pixel of a full-view pass.
 */
export function pickPixelProjection(
  projection: Matrix, px: number, py: number, width: number, height: number, result = new Matrix(),
): Matrix {
  const centreX = (2 * (px + 0.5)) / width - 1;
  const centreY = 1 - (2 * (py + 0.5)) / height;
  // Babylon multiplies row vectors: clip' = clip × region.
  const region = Matrix.FromValues(
    width, 0, 0, 0,
    0, height, 0, 0,
    0, 0, 1, 0,
    -centreX * width, -centreY * height, 0, 1,
  );
  return projection.multiplyToRef(region, result);
}

/**
 * The clip volume of pixel (`px`, `py`): the planes of the camera's view times its pick
 * projection. Anything the pick pass rasterises into its one texel meets this volume.
 */
export function pickFrustumPlanes(camera: Camera, px: number, py: number, width: number, height: number): Plane[] {
  const pick = pickPixelProjection(camera.getProjectionMatrix(), px, py, width, height);
  return Frustum.GetPlanes(camera.getViewMatrix().multiply(pick));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The graph behind `gpuPickMesh`, built once per Scene: 1×1 depth and object-ID
 * targets, a depth clear and one geometry task. A tap only swaps in its camera,
 * object list, id numbering and pick projection, so the pass keeps one render
 * pass id and every submesh keeps its draw state for it between taps. Nothing
 * here depends on the canvas size.
 */
class PickPass {
  private readonly scene: Scene;
  private graph: FrameGraph | undefined;
  private clear: FrameGraphClearTextureTask | undefined;
  private geometry: LogicalGeometryTask | undefined;
  private camera: Camera;
  private ids: ReadonlyMap<AbstractMesh, number> = new Map();
  /** Refilled before each draw; the renderer's init hook binds it as the scene projection. */
  private readonly projection = new Matrix();

  constructor(scene: Scene, camera: Camera, objects: AbstractMesh[]) {
    this.scene = scene;
    this.camera = camera;
    try {
      const graph = (this.graph = new FrameGraph(scene));
      scene.removeFrameGraph(graph);
      const depth = graph.textureManager.createRenderTargetTexture("GPU Pick Depth", {
        size: PICK_TARGET_SIZE,
        sizeIsPercentage: false,
        options: {
          createMipMaps: false,
          samples: 1,
          types: [Constants.TEXTURETYPE_FLOAT],
          formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
          useSRGBBuffers: [false],
        },
      });
      const clear = (this.clear = new FrameGraphClearTextureTask("GPU Pick Clear", graph));
      clear.depthTexture = depth;
      clear.clearColor = false;
      clear.clearDepth = true;
      clear.clearStencil = false;
      graph.addTask(clear);
      // The pass supplies its own pick projection: keep the renderer from
      // recomputing the camera projection with the 1×1 target's aspect ratio.
      const geometry = (this.geometry = new LogicalGeometryTask("GPU Pick Object IDs", graph, scene, { doNotChangeAspectRatio: true }));
      geometry.camera = camera;
      geometry.objectList = { meshes: objects, particleSystems: [] };
      geometry.depthTexture = clear.outputDepthTexture;
      geometry.size = { ...PICK_TARGET_SIZE };
      geometry.sizeIsPercentage = false;
      geometry.samples = 1;
      geometry.dontRenderWhenMaterialDepthWriteIsDisabled = false;
      // LOD levels report their master so the hit resolves to the authored mesh.
      geometry.objectIdProvider = (mesh) => this.ids.get(mesh._masterMesh ?? mesh) ?? this.ids.get(mesh) ?? 0;
      geometry.textureDescriptions.push({
        type: Constants.PREPASS_OBJECT_ID_TEXTURE_TYPE,
        textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE,
        textureFormat: Constants.TEXTUREFORMAT_RGBA,
      });
      const renderer = geometry.objectRenderer;
      renderer.dontSetTransformationMatrix = true;
      // initRender runs inside execute() and readiness probes (which restore
      // the scene matrices themselves); `render` fills the projection first.
      renderer.onInitRenderingObservable.add(() => scene.setTransformMatrix(this.camera.getViewMatrix(), this.projection));
      graph.addTask(geometry);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Record the tasks and allocate the 1×1 targets. */
  async build(): Promise<void> {
    await this.graph?.buildAsync(false);
  }

  /** Strictly probe `objects`, a subset of what the next draw renders, under this pass's id. */
  isReady(camera: Camera, objects: AbstractMesh[]): boolean {
    this.aim(camera, objects);
    return this.graph?.isReady() ?? false;
  }

  /** Draw `meshes` into the targets for pixel (`px`, `py`) of a `width` × `height` view. */
  render(
    camera: Camera, meshes: AbstractMesh[], ids: ReadonlyMap<AbstractMesh, number>,
    px: number, py: number, width: number, height: number,
  ) {
    const { scene, graph, geometry } = this;
    if (!graph || !geometry) return null;
    this.ids = ids;
    this.aim(camera, meshes);
    // Between frames no target is bound, so this is the projection the canvas
    // was drawn with (full-view aspect ratio).
    pickPixelProjection(camera.getProjectionMatrix(), px, py, width, height, this.projection);
    try {
      graph.execute();
    } finally {
      // The pass rendered with the scene's own camera, so Babylon does not
      // restore the scene matrices; put the camera's projection back.
      scene.setTransformMatrix(camera.getViewMatrix(), camera.getProjectionMatrix());
    }
    return graph.textureManager.getTextureFromHandle(geometry.geometryObjectIdTexture);
  }

  /** Drop the object list so an idle pass keeps no mesh alive. */
  clearObjects(): void {
    if (!this.geometry) return;
    this.geometry.objectList = { meshes: [], particleSystems: [] };
    this.geometry.objectRenderer.renderList = [];
  }

  dispose(): void {
    const { graph, clear, geometry } = this;
    this.graph = this.clear = this.geometry = undefined;
    // FrameGraph.dispose resets its tasks without disposing them: the geometry
    // task owns the ObjectRenderer, whose render pass ids are released here.
    for (const release of [() => geometry?.dispose(), () => clear?.dispose(), () => graph?.dispose()]) {
      try { release(); } catch { /* the remaining parts still have to be released */ }
    }
  }

  private aim(camera: Camera, meshes: AbstractMesh[]): void {
    if (!this.geometry) return;
    this.camera = camera;
    this.geometry.camera = camera;
    this.geometry.objectList = { meshes, particleSystems: [] };
  }
}

/**
 * Which meshes the persistent pass has already proven drawable, so a tap
 * strictly probes only those that are new or changed. Probing a mesh compiles
 * and awaits its object-ID variant, the expensive part of a tap.
 *
 * A proof is per mesh and is dropped when the mesh's material (or thin-instance
 * mode) changes, so a new material or mesh costs only its own probe. It is
 * dropped for every mesh when a shared input changes: lights, textures,
 * skeletons, the camera, or the project's own rendering-definition signal
 * (`markSceneReadinessDirty`), the same invalidation the scene renderer's
 * cached strict readiness follows. Babylon defers its add/remove observables,
 * so tap time also compares the collection sizes and light states directly.
 *
 * A mesh that outlasted the readiness wait is latched under the same terms, so
 * the next tap that needs it re-probes it once instead of waiting again.
 */
class PickReadiness {
  private readonly scene: Scene;
  private proven = new WeakMap<AbstractMesh, { material: Material | null; instanced: boolean }>();
  private latched = new WeakMap<AbstractMesh, { material: Material | null; instanced: boolean }>();
  private revision = 0;
  private readonly seen: number[] = [];
  private readonly detach: Array<() => void> = [];

  constructor(scene: Scene) {
    this.scene = scene;
    const invalidate = () => { this.revision += 1; };
    const watch = <T>(observable: Observable<T>) => {
      const observer = observable.add(invalidate);
      this.detach.push(() => observable.remove(observer));
    };
    watch(scene.onNewLightAddedObservable);
    watch(scene.onLightRemovedObservable);
    watch(scene.onNewTextureAddedObservable);
    watch(scene.onTextureRemovedObservable);
    watch(scene.onNewSkeletonAddedObservable);
    watch(scene.onSkeletonRemovedObservable);
    this.detach.push(onSceneReadinessDirty(scene, invalidate));
  }

  /** Changes seen so far; a proof taken at an older value is stale. */
  get stamp(): number {
    return this.revision;
  }

  /** The meshes whose readiness for the pass is not proven. */
  unproven(meshes: readonly AbstractMesh[], camera: Camera): AbstractMesh[] {
    this.syncSharedInputs(camera);
    return meshes.filter((mesh) => !this.holds(this.proven, mesh));
  }

  /** The meshes among `meshes` that already outlasted the readiness wait and have not changed since. */
  latchedAmong(meshes: readonly AbstractMesh[]): AbstractMesh[] {
    return meshes.filter((mesh) => this.holds(this.latched, mesh));
  }

  /** Record `meshes` as proven, unless something changed since `stamp`. */
  prove(meshes: readonly AbstractMesh[], stamp: number): void {
    if (stamp !== this.revision) return;
    for (const mesh of meshes) {
      this.proven.set(mesh, { material: mesh.material ?? null, instanced: mesh.hasThinInstances });
      this.latched.delete(mesh);
    }
  }

  /** Record `mesh` as not becoming ready within the wait, unless something changed since `stamp`. */
  latch(mesh: AbstractMesh, stamp: number): void {
    if (stamp === this.revision) this.latched.set(mesh, { material: mesh.material ?? null, instanced: mesh.hasThinInstances });
  }

  /** Forget every proof and latch, e.g. when the pass (and its render pass id) is replaced. */
  reset(): void {
    this.proven = new WeakMap();
    this.latched = new WeakMap();
  }

  private holds(record: WeakMap<AbstractMesh, { material: Material | null; instanced: boolean }>, mesh: AbstractMesh): boolean {
    const entry = record.get(mesh);
    return !!entry && entry.material === (mesh.material ?? null) && entry.instanced === mesh.hasThinInstances;
  }

  dispose(): void {
    for (const release of this.detach.splice(0)) release();
    this.reset();
  }

  private syncSharedInputs(camera: Camera): void {
    const { scene, seen } = this;
    let index = 0;
    let changed = false;
    const note = (value: number): void => {
      if (seen[index] !== value) { seen[index] = value; changed = true; }
      index += 1;
    };
    note(this.revision);
    note(scene.lights.length);
    note(scene.textures.length);
    note(scene.skeletons.length);
    note(camera.uniqueId);
    note(camera.mode);
    for (const light of scene.lights) note(light.isEnabled() ? 1 : 0);
    seen.length = index;
    if (changed) this.reset();
  }
}

/** Per-Scene state of `gpuPickMesh`: the lazily built persistent pass and the queue serialising taps. */
class ScenePicker {
  private readonly scene: Scene;
  private pass: PickPass | undefined;
  private readonly readiness: PickReadiness;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.readiness = new PickReadiness(scene);
    scene.onDisposeObservable.add(() => this.dispose());
  }

  /**
   * Taps share one 1×1 target, so they run one at a time: a second draw before
   * the first read-back would overwrite its texel.
   */
  pick(x: number, y: number): Promise<GpuPickResult> {
    const result = this.tail.then(() => this.run(x, y));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Release the pass while the scene and engine are still alive (Babylon notifies before disposing meshes). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.dispose();
    this.discard();
  }

  private discard(): void {
    const pass = this.pass;
    this.pass = undefined;
    this.readiness.reset();
    pass?.dispose();
  }

  /** The wait ran out: probe each unproven mesh alone to prove the ready ones and latch the stuck ones. */
  private latchStuck(pass: PickPass, camera: Camera, unproven: readonly AbstractMesh[], stamp: number): void {
    for (const mesh of unproven) {
      if (pass.isReady(camera, [mesh])) this.readiness.prove([mesh], stamp);
      else this.readiness.latch(mesh, stamp);
    }
  }

  private async run(x: number, y: number): Promise<GpuPickResult> {
    const { scene } = this;
    let pass: PickPass | undefined;
    try {
      if (this.disposed || scene.isDisposed) return undefined;
      const engine = scene.getEngine();
      const camera = scene.activeCamera;
      if (!camera || typeof engine._readTexturePixels !== "function") return undefined;
      if (camera.cameraRigMode !== Camera.RIG_MODE_NONE) return undefined;
      const viewport = camera.viewport;
      if (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1) return undefined;
      const width = engine.getRenderWidth();
      const height = engine.getRenderHeight();
      const scale = engine.getHardwareScalingLevel() || 1;
      const px = Math.floor(x / scale);
      const py = Math.floor(y / scale);
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      const meshes = gpuPickableMeshes(scene);
      if (meshes.length === 0) return null;
      if (meshes.length >= 0xffffff) return undefined;
      // Ids number every pickable mesh, so an id means the same mesh whichever subset is drawn.
      const ids = new Map<AbstractMesh, number>(meshes.map((mesh, index) => [mesh, index + 1]));
      // Only meshes that can reach this pixel are drawn and awaited; the others cannot change its result.
      const candidates = pickCandidates(scene, meshes, pickFrustumPlanes(camera, px, py, width, height));
      if (candidates.length === 0) return null;

      pass = this.pass;
      if (!pass) {
        pass = this.pass = new PickPass(scene, camera, candidates);
        await pass.build();
        if (this.disposed) return undefined;
      }
      const deadline = performance.now() + READY_TIMEOUT_MS;
      for (;;) {
        const unproven = this.readiness.unproven(candidates, camera);
        if (unproven.length === 0) break;
        const stamp = this.readiness.stamp;
        const stuck = this.readiness.latchedAmong(unproven);
        if (stuck.length > 0) {
          // A candidate that already outlasted a full wait: probe it once, then take the CPU ray
          // rather than wait again. Drawing without it could pick a mesh behind it.
          if (performance.now() > deadline || !pass.isReady(camera, stuck)) return undefined;
          this.readiness.prove(stuck, stamp);
          continue;
        }
        if (pass.isReady(camera, unproven)) {
          this.readiness.prove(unproven, stamp);
          break;
        }
        if (performance.now() > deadline) {
          this.latchStuck(pass, camera, unproven, stamp);
          return undefined;
        }
        await wait(READY_POLL_MS);
        if (this.disposed) return undefined;
      }
      const texture = pass.render(camera, candidates, ids, px, py, width, height);
      if (!texture) return undefined;
      // One texel: WebGL's bottom-up and WebGPU's top-down rows coincide.
      const pixel = new Uint8Array(engine.isWebGPU ? 256 : 4);
      await engine._readTexturePixels(texture, 1, 1, -1, 0, pixel, true, true, 0, 0);
      if (this.disposed) return undefined;
      const id = decodeObjectId(pixel);
      return id === 0 ? null : meshes[id - 1] ?? null;
    } catch {
      // Hand this tap to the CPU ray; the next one starts from a fresh pass.
      if (pass) this.discard();
      return undefined;
    } finally {
      pass?.clearObjects();
    }
  }
}

const pickers = new WeakMap<Scene, ScenePicker>();

/**
 * Pick through each mesh's own material in a geometry pass writing Babylon's
 * object-ID texture. Vertex deformation (skinning, morphs, lattice, water,
 * node-material offsets) therefore matches what is drawn, unlike the CPU ray
 * against bind-pose geometry. Only the tapped pixel is rendered: a pick
 * projection fills 1×1 object-ID and depth targets with it, so the pass costs
 * one texel regardless of viewport size. Coordinates are `scene.pick` pixels.
 *
 * The graph, its targets and its render pass id persist per Scene: the first
 * tap builds them and Scene disposal releases them. A tap draws, and strictly
 * probes, only the meshes that can reach its pixel (bounds meet the pixel's
 * clip volume, or the mesh can draw outside its bounds) and that are new or
 * changed since the pass last proved them drawable. A mesh that outlasts the
 * one-second wait is latched until it changes: a tap that needs it probes it
 * once and takes the CPU ray at once instead of waiting again. Taps run one at
 * a time in call order. `undefined` means use the CPU ray.
 */
export async function gpuPickMesh(scene: Scene, x: number, y: number): Promise<GpuPickResult> {
  if (scene.isDisposed) return undefined;
  let picker = pickers.get(scene);
  if (!picker) pickers.set(scene, picker = new ScenePicker(scene));
  return picker.pick(x, y);
}
