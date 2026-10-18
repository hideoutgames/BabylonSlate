import type { AbstractMesh, Material, Observable, Plane, Scene } from "@babylonjs/core";
import { Camera, Constants, Frustum, Matrix, Mesh } from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";
import { pickCandidates } from "./gpu-pick-candidates";
import { onSceneReadinessDirty, pinFloatingOrigin } from "./scene-readiness-signal";

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
 * The clip volume of pixel (`px`, `py`): the planes of `view` times the pick projection of
 * `projection`. Anything the pick pass rasterises into its one texel meets this volume.
 */
export function pickFrustumPlanes(view: Matrix, projection: Matrix, px: number, py: number, width: number, height: number): Plane[] {
  return Frustum.GetPlanes(view.multiply(pickPixelProjection(projection, px, py, width, height)));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WARN_INTERVAL_MS = 5000;
const lastWarned = new Map<string, number>();

/**
 * A GPU pick that hands its tap to the CPU ray returns the bind-pose answer, which can differ from
 * what is drawn, so say why. Each cause is reported at most once per interval: a stuck mesh would
 * otherwise repeat the line on every tap.
 */
function warnFallback(cause: string, detail: string): void {
  const now = performance.now();
  const last = lastWarned.get(cause);
  if (last !== undefined && now >= last && now - last < WARN_INTERVAL_MS) return;
  lastWarned.set(cause, now);
  console.warn(`[render] GPU pick fell back to the CPU ray: ${detail}`);
}

/** Up to three mesh names, for a log line. */
function nameMeshes(meshes: readonly AbstractMesh[]): string {
  const shown = meshes.slice(0, 3).map((mesh) => mesh.name || "(unnamed)").join(", ");
  return meshes.length > 3 ? `${shown} and ${meshes.length - 3} more` : shown;
}

/**
 * What a tap sees, taken when the tap is made. Taps queue, and a camera that keeps moving while an
 * earlier tap waits must not change where a later one points: the user clicked on the frame they
 * were looking at.
 */
interface Tap {
  readonly camera: Camera;
  readonly view: Matrix;
  readonly projection: Matrix;
  readonly width: number;
  readonly height: number;
  readonly px: number;
  readonly py: number;
}

/**
 * The graph behind `gpuPickMesh`, built once per Scene: 1×1 depth and object-ID
 * targets, a depth clear and one geometry task. A tap only swaps in its camera,
 * object list, id numbering and the view and pick projection it was made with,
 * so the pass keeps one render pass id and its submeshes keep their draw state
 * for it between taps (which is why every tap re-probes what it draws). Nothing
 * here depends on the canvas size.
 */
class PickPass {
  private readonly scene: Scene;
  private graph: FrameGraph | undefined;
  private clear: FrameGraphClearTextureTask | undefined;
  private geometry: LogicalGeometryTask | undefined;
  private ids: ReadonlyMap<AbstractMesh, number> = new Map();
  /** Refilled from the tap before each probe and draw; the renderer's init hook binds them as the scene matrices. */
  private readonly view = new Matrix();
  private readonly projection = new Matrix();

  constructor(scene: Scene, camera: Camera, objects: AbstractMesh[]) {
    this.scene = scene;
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
      renderer.onInitRenderingObservable.add(() => scene.setTransformMatrix(this.view, this.projection));
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

  /**
   * Strictly probe `objects`, the ones the next draw renders, and the levels of detail they may
   * draw through, under this pass's id and `tap`'s view.
   */
  isReady(tap: Tap, objects: AbstractMesh[]): boolean {
    this.aim(tap, objects);
    if (!this.graph) return false;
    // Both probes run, so every missing variant is requested in the same poll.
    const levels = this.levelsReady(objects);
    const meshes = this.graph.isReady();
    return levels && meshes;
  }

  /** Draw `meshes` through `tap`'s view into the targets for the tapped pixel. */
  render(tap: Tap, meshes: AbstractMesh[], ids: ReadonlyMap<AbstractMesh, number>) {
    const { scene, graph, geometry } = this;
    if (!graph || !geometry) return null;
    this.ids = ids;
    this.aim(tap, meshes);
    // Between frames Babylon's floating-origin context is the last scene to render, in the editor the
    // gizmo's utility layer, whose full-view matrices would replace the pick projection and make every
    // tap sample the viewport centre. Select this scene for the draw, as the readiness probes do.
    const unpin = pinFloatingOrigin(scene);
    try {
      graph.execute();
    } finally {
      try {
        // The pass rendered through the tap's matrices, not the scene's camera, so Babylon does not
        // restore the scene matrices; put the camera's current ones back.
        scene.setTransformMatrix(tap.camera.getViewMatrix(), tap.camera.getProjectionMatrix());
      } finally {
        unpin();
      }
    }
    return graph.textureManager.getTextureFromHandle(geometry.geometryObjectIdTexture);
  }

  /**
   * Drop the object list, the id numbering and the meshes probed ahead (a tap that gave up never let the pass report
   * ready, which would forget them) so an idle pass keeps no mesh alive.
   */
  clearObjects(): void {
    this.ids = new Map();
    if (!this.geometry) return;
    this.geometry.objectList = { meshes: [], particleSystems: [] };
    this.geometry.objectRenderer.renderList = [];
    this.geometry.forgetCompilesAhead();
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

  /**
   * A mesh is drawn through whichever level of detail the camera selects, and a level is blocked:
   * the renderer's readiness check skips it and `Mesh.isReady(true)` only probes it without the
   * complete check. Probe every level strictly here, under this pass's render pass id, so the level
   * that gets drawn has its variant. Probing all of them leaves the choice (and the editor's
   * hysteresis) to the draw.
   */
  private levelsReady(meshes: readonly AbstractMesh[]): boolean {
    const renderer = this.geometry?.objectRenderer;
    if (!renderer) return false;
    const engine = this.scene.getEngine();
    const previous = engine.currentRenderPassId;
    engine.currentRenderPassId = renderer.renderPassId;
    try {
      let ready = true;
      for (const mesh of meshes)
        if (mesh instanceof Mesh)
          for (const level of mesh.getLODLevels()) ready = (level.mesh?.isReady(true) ?? true) && ready;
      return ready;
    } finally {
      engine.currentRenderPassId = previous;
    }
  }

  private aim(tap: Tap, meshes: AbstractMesh[]): void {
    if (!this.geometry) return;
    this.view.copyFrom(tap.view);
    // The projection the canvas was drawn with (full-view aspect ratio), narrowed to the tapped pixel.
    pickPixelProjection(tap.projection, tap.px, tap.py, tap.width, tap.height, this.projection);
    this.geometry.camera = tap.camera;
    this.geometry.objectList = { meshes, particleSystems: [] };
  }
}

/**
 * Meshes whose object-ID variant outlasted the readiness wait, so the next tap
 * that needs one probes it once instead of waiting a full second again.
 *
 * Only this is remembered between taps. Readiness itself is never cached: a
 * mesh can go stale in place (a define-changing `material.markDirty()`, a
 * skeleton, morph or vertex-layout change) without any signal this module sees,
 * and a draw skips a mesh whose variant is not ready, which makes the tap select
 * whatever lies behind it. Every tap therefore strictly probes every mesh it draws.
 *
 * A latch is per mesh and ends when the mesh's material (or thin-instance mode)
 * changes. It ends for every mesh when a shared input changes: lights, textures,
 * skeletons, the camera, or the project's own rendering-definition signal
 * (`markSceneReadinessDirty`), the same invalidation the scene renderer's cached
 * strict readiness follows. Babylon defers its add/remove observables, so tap
 * time also compares the collection sizes and light states directly.
 */
class PickLatch {
  private readonly scene: Scene;
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

  /** The meshes among `meshes` that already outlasted the readiness wait and have not changed since. */
  among(meshes: readonly AbstractMesh[], camera: Camera): AbstractMesh[] {
    this.syncSharedInputs(camera);
    return meshes.filter((mesh) => {
      const entry = this.latched.get(mesh);
      return !!entry && entry.material === (mesh.material ?? null) && entry.instanced === mesh.hasThinInstances;
    });
  }

  /** Remember that `mesh` did not become ready within the wait. */
  latch(mesh: AbstractMesh): void {
    this.latched.set(mesh, { material: mesh.material ?? null, instanced: mesh.hasThinInstances });
  }

  release(mesh: AbstractMesh): void {
    this.latched.delete(mesh);
  }

  /** Forget every latch, e.g. when the pass (and its render pass id) is replaced. */
  reset(): void {
    this.latched = new WeakMap();
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
  private readonly latch: PickLatch;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.latch = new PickLatch(scene);
    scene.onDisposeObservable.add(() => this.dispose());
  }

  /**
   * Taps share one 1×1 target, so they run one at a time: a second draw before
   * the first read-back would overwrite its texel. What a tap sees (camera,
   * matrices, render size, scale, pixel) is read here, when it is made, not when
   * its turn comes.
   */
  pick(x: number, y: number): Promise<GpuPickResult> {
    const tap = this.snapshot(x, y);
    const result = this.tail.then(() => "camera" in tap ? this.run(tap) : tap.answer);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Release the pass while the scene and engine are still alive (Babylon notifies before disposing meshes). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.latch.dispose();
    this.discard();
  }

  private discard(): void {
    const pass = this.pass;
    this.pass = undefined;
    this.latch.reset();
    pass?.dispose();
  }

  /** The tap as made, or the answer when the GPU path cannot take it. */
  private snapshot(x: number, y: number): Tap | { answer: GpuPickResult } {
    const { scene } = this;
    if (this.disposed || scene.isDisposed) return { answer: undefined };
    const engine = scene.getEngine();
    const camera = scene.activeCamera;
    if (!camera || typeof engine._readTexturePixels !== "function") return { answer: undefined };
    if (camera.cameraRigMode !== Camera.RIG_MODE_NONE) {
      warnFallback("rig", "the camera uses a rig");
      return { answer: undefined };
    }
    const viewport = camera.viewport;
    if (viewport.x !== 0 || viewport.y !== 0 || viewport.width !== 1 || viewport.height !== 1) {
      warnFallback("viewport", "the camera viewport is not full-frame");
      return { answer: undefined };
    }
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const scale = engine.getHardwareScalingLevel() || 1;
    const px = Math.floor(x / scale);
    const py = Math.floor(y / scale);
    if (px < 0 || py < 0 || px >= width || py >= height) return { answer: null };
    // Between frames no target is bound, so the camera's projection is the one the canvas was drawn with.
    return { camera, view: camera.getViewMatrix().clone(), projection: camera.getProjectionMatrix().clone(), width, height, px, py };
  }

  /** The wait ran out: probe each candidate alone and latch the ones that are still not ready. */
  private latchStuck(pass: PickPass, tap: Tap, candidates: readonly AbstractMesh[]): AbstractMesh[] {
    const stuck: AbstractMesh[] = [];
    for (const mesh of candidates) {
      if (pass.isReady(tap, [mesh])) continue;
      this.latch.latch(mesh);
      stuck.push(mesh);
    }
    return stuck;
  }

  private async run(tap: Tap): Promise<GpuPickResult> {
    const { scene } = this;
    let pass: PickPass | undefined;
    try {
      if (this.disposed || scene.isDisposed) return undefined;
      const engine = scene.getEngine();
      const meshes = gpuPickableMeshes(scene);
      if (meshes.length === 0) return null;
      if (meshes.length >= 0xffffff) {
        warnFallback("capacity", `${meshes.length} pickable meshes exceed the 24-bit id range`);
        return undefined;
      }
      // Ids number every pickable mesh, so an id means the same mesh whichever subset is drawn.
      const ids = new Map<AbstractMesh, number>(meshes.map((mesh, index) => [mesh, index + 1]));
      // Only meshes that can reach this pixel are drawn and awaited; the others cannot change its result.
      const candidates = pickCandidates(scene, meshes, pickFrustumPlanes(tap.view, tap.projection, tap.px, tap.py, tap.width, tap.height));
      if (candidates.length === 0) return null;

      pass = this.pass;
      if (!pass) {
        pass = this.pass = new PickPass(scene, tap.camera, candidates);
        await pass.build();
        if (this.disposed) return undefined;
      }
      const deadline = performance.now() + READY_TIMEOUT_MS;
      for (;;) {
        const stuck = this.latch.among(candidates, tap.camera);
        if (stuck.length > 0) {
          // A candidate that already outlasted a full wait: probe it once, then take the CPU ray
          // rather than wait again. Drawing without it could pick a mesh behind it.
          if (performance.now() > deadline || !pass.isReady(tap, stuck)) {
            warnFallback("latched", `${nameMeshes(stuck)} timed out earlier and lies under the tapped pixel`);
            return undefined;
          }
          for (const mesh of stuck) this.latch.release(mesh);
          continue;
        }
        // Every tap strictly probes every mesh it is about to draw: a draw skips a mesh whose variant is not ready.
        if (pass.isReady(tap, candidates)) break;
        if (performance.now() > deadline) {
          const timedOut = this.latchStuck(pass, tap, candidates);
          warnFallback("timeout", `meshes not ready within ${READY_TIMEOUT_MS} ms: ${nameMeshes(timedOut.length > 0 ? timedOut : candidates)}`);
          return undefined;
        }
        await wait(READY_POLL_MS);
        if (this.disposed) return undefined;
      }
      const texture = pass.render(tap, candidates, ids);
      if (!texture) return undefined;
      // One texel: WebGL's bottom-up and WebGPU's top-down rows coincide.
      const pixel = new Uint8Array(engine.isWebGPU ? 256 : 4);
      await engine._readTexturePixels(texture, 1, 1, -1, 0, pixel, true, true, 0, 0);
      if (this.disposed) return undefined;
      const id = decodeObjectId(pixel);
      return id === 0 ? null : meshes[id - 1] ?? null;
    } catch (error) {
      // Hand this tap to the CPU ray; the next one starts from a fresh pass.
      warnFallback("exception", `the pick pass failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * probes on every tap, only the meshes that can reach its pixel (bounds meet
 * the pixel's clip volume, or the mesh can draw outside its bounds). A mesh
 * that outlasts the one-second wait is latched until its material, thin-instance
 * mode or the scene's readiness inputs change: a tap that needs it probes it
 * once and takes the CPU ray at once instead of waiting again. The camera,
 * matrices, render size, scale and pixel are read when `gpuPickMesh` is called,
 * and taps then run one at a time in call order. `undefined` means use the CPU
 * ray, and the cause is logged (rate limited).
 */
export async function gpuPickMesh(scene: Scene, x: number, y: number): Promise<GpuPickResult> {
  if (scene.isDisposed) return undefined;
  let picker = pickers.get(scene);
  if (!picker) pickers.set(scene, picker = new ScenePicker(scene));
  return picker.pick(x, y);
}
