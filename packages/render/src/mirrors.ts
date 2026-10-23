/**
 * Mirror components: a flat surface (Width × Height in its local X–Y plane, reflective side toward local −Z, as a
 * Plane mesh faces) that shows the scene reflected across its plane from the current view's camera.
 *
 * Each surface is an ordinary scene mesh drawing the built-in mirror material (or the component's Material override,
 * which can read the reflection through a Mirror Reflection node). One owner per scene draws the reflections from
 * `onBeforeRender` through the planar mirror pass water uses (`planar-mirror.ts`): an oblique mirror camera renders
 * the opaque scene into the surface's own leased target, never the mirror surfaces themselves or water, so no
 * surface ever samples the target it is drawing into.
 *
 * Budget (`mirror-selection.ts`): a reflection is one more scene draw on the main thread, so a render draws at most
 * `MIRROR_RENDERS_PER_FRAME` surfaces that the view sees from their reflective side, never-drawn first, then nearest;
 * the others keep their last image. A target allocates on a surface's first draw and lives with the surface (resized
 * when the view's size or Resolution Scale changes), so a skipped surface always has its last image to show.
 *
 * Views that draw no reflections (their surfaces keep their last image): orthographic, rig/XR and multi-camera views,
 * Clustered Forward views (their light data is sorted for the view camera), Scene Linear without half-float targets,
 * and Render Target Captures, which show what the scene view drew.
 */
import {
  Camera, Color4, Constants, Frustum, Matrix, MeshBuilder, NodeMaterial, ShaderLanguage, Vector3,
  FragmentOutputBlock, type AbstractMesh, type Mesh, type NodeMaterialBlock, type Observer, type RenderTargetTexture, type Scene,
} from "@babylonjs/core";
import type { MirrorProperties } from "@haptic/core";
import { clusteredLightTarget } from "./clustered-light-policy";
import { registerClusteredUnlitMaterial } from "./clustered-material-policy";
import type { ManagedRenderResource } from "./managed-render-resources";
import { MirrorReflectionBlock } from "./mirror-reflection-block";
import { MIRROR_RENDERS_PER_FRAME, selectMirrorsToRender, type MirrorCandidate } from "./mirror-selection";
import { createMirrorReflectionBinding, isMirrorSurfaceMesh, type MirrorReflectionBinding } from "./mirror-surface-state";
import {
  beginPlanarMirrorPassState, buildViewProjectionMatrix, clipFrustumAtMirror, collectPlanarMirrorMeshes, createPlanarMirrorTarget,
  disposePlanarMirrorTarget, drawPlanarMirrorPass, planarMirrorTargetSize, PlanarMirrorMath, resizePlanarMirrorTarget,
  type MirrorPlane, type PlanarMirrorTargetState,
} from "./planar-mirror";
import { renderTargetCaptureDrawing } from "./render-target-capture-state";
import { managedRenderTargetResources } from "./render-target-resource-cost";
import { shadowSamplerPlaceholders } from "./shadow-sampler-placeholders";
import { createSurfacePlumbing } from "./surface-material-plumbing";
import type { MaterialPlumbing } from "./material-block-registry";
import { rebindEmptiedDrawContexts } from "./webgpu-node-material-rebind";

export { isMirrorSurfaceMesh } from "./mirror-surface-state";

const DRAW_POLICY = { restoreAlpha: true, wrapDrawFailure: false, message: "Mirror reflection failed." };

/** Counters for proofs and tests; null when the scene has no Mirror surface. */
export interface MirrorDiagnostics {
  /** Registered Mirror surfaces. */
  readonly surfaces: number;
  /** Surfaces holding GPU storage for their reflection. */
  readonly targets: number;
  /** Reflections drawn. */
  readonly draws: number;
  /** Reflections drawn in the last scene render that drew any. */
  readonly lastRenderDraws: number;
}

type Surface = MirrorCandidate & {
  readonly mesh: Mesh;
  readonly properties: MirrorProperties;
  readonly binding: MirrorReflectionBinding;
  readonly plane: MirrorPlane;
  target: PlanarMirrorTargetState | null;
  /** The first draw waits for every reflected material; later draws skip any mesh that is not ready. */
  ready: boolean;
  failed: boolean;
};

const owners = new WeakMap<Scene, SceneMirrors>();
const builtInMaterials = new WeakMap<Scene, NodeMaterial>();

function excludedFromMirrors(mesh: AbstractMesh): boolean {
  return isMirrorSurfaceMesh(mesh) || (mesh.metadata as { slateWater?: unknown } | null)?.slateWater === true;
}

function mirrorResources(texture: RenderTargetTexture): ManagedRenderResource[] {
  return managedRenderTargetResources(texture.renderTarget!, { colorCategory: "sceneColor" });
}

class SceneMirrors {
  readonly surfaces: Surface[] = [];
  draws = 0;
  lastRenderDraws = 0;
  private readonly scene: Scene;
  private beforeRender: Observer<Scene> | null = null;
  private order = 0;
  private drawing = false;
  private drawTarget: PlanarMirrorTargetState | null = null;
  private drawSurface: Surface | null = null;
  private drew = false;
  private readonly selected: Surface[] = [];
  private readonly math = new PlanarMirrorMath();
  private readonly projection = new Matrix();
  private readonly viewProjection = new Matrix();
  private readonly cullViewProjection = new Matrix();
  private readonly relativeView = new Matrix();
  private readonly planes = Frustum.GetPlanes(Matrix.Identity());
  private readonly reflectionPlanes = Frustum.GetPlanes(Matrix.Identity());
  private readonly scratch = new Vector3();
  private readonly drawPass = () => {
    const surface = this.drawSurface!, target = this.drawTarget!;
    beginPlanarMirrorPassState(this.scene.getEngine());
    if (!surface.ready) surface.ready = target.texture.isReadyForRendering();
    if (surface.ready) { target.texture.render(false); this.drew = true; }
  };

  constructor(scene: Scene) {
    this.scene = scene;
  }

  add(mesh: Mesh, properties: MirrorProperties): void {
    const surface: Surface = {
      mesh, properties, binding: createMirrorReflectionBinding(mesh, properties.tint), plane: { nx: 0, ny: 0, nz: -1, d: 0 },
      target: null, ready: false, failed: false, drawn: false, visible: false, order: this.order++, distance: 0,
      cx: 0, cy: 0, cz: 0, nx: 0, ny: 0, nz: -1, ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0,
    };
    this.surfaces.push(surface);
    // Two surfaces sharing a Material and Effect would otherwise skip the second one's bind (its texture).
    mesh.onBeforeBindObservable.add(() => this.scene.resetCachedMaterial());
    mesh.onDisposeObservable.addOnce(() => this.remove(surface));
    this.beforeRender ??= this.scene.onBeforeRenderObservable.add(() => this.update());
  }

  diagnostics(): MirrorDiagnostics {
    return {
      surfaces: this.surfaces.length, targets: this.surfaces.filter((surface) => surface.target?.lease).length,
      draws: this.draws, lastRenderDraws: this.lastRenderDraws,
    };
  }

  private remove(surface: Surface): void {
    const index = this.surfaces.indexOf(surface);
    if (index >= 0) this.surfaces.splice(index, 1);
    surface.binding.texture = null;
    if (surface.target) disposePlanarMirrorTarget(this.scene, surface.target);
    surface.target = null;
    if (!this.surfaces.length) {
      this.scene.onBeforeRenderObservable.remove(this.beforeRender);
      this.beforeRender = null;
    }
  }

  private update(): void {
    const scene = this.scene, engine = scene.getEngine();
    if (this.drawing || renderTargetCaptureDrawing.has(scene)) return;
    const camera = scene.activeCamera;
    if (!camera || camera.mode !== Camera.PERSPECTIVE_CAMERA || camera.rigCameras.length > 0 || (scene.activeCameras?.length ?? 0) > 1) return;
    if (clusteredLightTarget(scene, camera)) return;
    const linear = scene.imageProcessingConfiguration.applyByPostProcess;
    if (linear && !engine.getCaps().textureHalfFloatRender) return;
    const output = camera.outputRenderTarget;
    const viewWidth = (output ? output.getRenderWidth() : engine.getRenderWidth(true)) * camera.viewport.width;
    const viewHeight = (output ? output.getRenderHeight() : engine.getRenderHeight(true)) * camera.viewport.height;
    if (!(viewWidth >= 1 && viewHeight >= 1)) return;
    buildViewProjectionMatrix(scene, camera, viewWidth / viewHeight, this.projection);
    camera.getViewMatrix().multiplyToRef(this.projection, this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.planes);
    for (const surface of this.surfaces) this.place(surface, camera.layerMask);
    selectMirrorsToRender(camera.globalPosition, this.surfaces, MIRROR_RENDERS_PER_FRAME, this.selected);
    let draws = 0;
    for (const surface of this.selected) {
      try {
        if (this.renderSurface(surface, camera, viewWidth, viewHeight, linear)) draws++;
      } catch (error) {
        // An optional effect must not break the frame: this surface keeps its last image from now on.
        surface.failed = true;
        console.warn(`[render] Mirror reflection is off for "${surface.mesh.name}": ${String(error)}`);
      }
    }
    if (draws) this.lastRenderDraws = draws;
    this.selected.length = 0;
  }

  /** The surface's world rectangle, plane and eligibility for this render. */
  private place(surface: Surface, layerMask: number): void {
    const mesh = surface.mesh;
    surface.visible = false;
    if (surface.failed || !surface.properties.enabled || mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible ||
      mesh.visibility <= 0 || !(mesh.layerMask & layerMask)) return;
    const m = mesh.computeWorldMatrix().m;
    const halfWidth = surface.properties.width / 2, halfHeight = surface.properties.height / 2;
    surface.cx = m[12]!; surface.cy = m[13]!; surface.cz = m[14]!;
    surface.ux = m[0]! * halfWidth; surface.uy = m[1]! * halfWidth; surface.uz = m[2]! * halfWidth;
    surface.vx = m[4]! * halfHeight; surface.vy = m[5]! * halfHeight; surface.vz = m[6]! * halfHeight;
    // The reflective side is local −Z; under a mirrored (negative-determinant) transform it is the cross product.
    const normal = this.scratch.set(
      surface.vy * surface.uz - surface.vz * surface.uy,
      surface.vz * surface.ux - surface.vx * surface.uz,
      surface.vx * surface.uy - surface.vy * surface.ux,
    );
    const length = normal.length();
    if (!(length > 0)) return;
    surface.nx = normal.x / length; surface.ny = normal.y / length; surface.nz = normal.z / length;
    const plane = surface.plane;
    plane.nx = surface.nx; plane.ny = surface.ny; plane.nz = surface.nz;
    plane.d = -(surface.nx * surface.cx + surface.ny * surface.cy + surface.nz * surface.cz);
    surface.visible = mesh.isInFrustum(this.planes);
  }

  private renderSurface(surface: Surface, camera: Camera, viewWidth: number, viewHeight: number, linear: boolean): boolean {
    const scene = this.scene, engine = scene.getEngine();
    const maxSize = engine.getCaps().maxTextureSize;
    const scale = surface.properties.resolutionScale;
    const width = planarMirrorTargetSize(viewWidth, scale, maxSize), height = planarMirrorTargetSize(viewHeight, scale, maxSize);
    const type = linear ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    const target = this.ensureTarget(surface, camera, width, height, type);
    if (!target) return false;
    if (!this.math.mirror(camera.getViewMatrix(), camera.globalPosition, surface.plane, this.projection,
      engine.useReverseDepthBuffer, engine.isNDCHalfZRange, target.mirror.mirrorView, target.projection)) return false;
    const eye = this.math.eye;
    target.mirror.position.set(eye[0]!, eye[1]!, eye[2]!);
    // Cull with the mirror camera's ordinary frustum, its near plane replaced by the mirror plane.
    target.mirror.mirrorView.multiplyToRef(this.projection, this.cullViewProjection);
    clipFrustumAtMirror(this.cullViewProjection, surface.plane, this.reflectionPlanes);
    collectPlanarMirrorMeshes(scene, target.texture.renderList!, camera.layerMask, this.reflectionPlanes, excludedFromMirrors);
    target.mirror.minZ = camera.minZ;
    target.mirror.maxZ = camera.maxZ;
    target.mirror.getViewMatrix(true);
    if (!this.draw(surface, target)) return false;
    this.draws++;
    surface.drawn = true;
    const binding = surface.binding;
    // The shader's positions are relative to the floating origin (the view's eye) when it is on.
    binding.origin.copyFrom(scene.floatingOriginMode ? camera.globalPosition : Vector3.ZeroReadOnly);
    this.math.relativeViewProjection(binding.origin, target.projection, this.relativeView, binding.viewProjection);
    binding.gammaSpace = !linear;
    binding.texture = target.thin;
    return true;
  }

  /** The surface's target holding storage of this size and type; null when the ledger refuses it. */
  private ensureTarget(surface: Surface, camera: Camera, width: number, height: number, type: number): PlanarMirrorTargetState | null {
    let target = surface.target;
    // A colour-type change (Scene Linear on or off) is a settings change: rebuild the target for its new format.
    if (target && target.type !== type) {
      surface.binding.texture = null;
      surface.drawn = false;
      disposePlanarMirrorTarget(this.scene, target);
      target = surface.target = null;
    }
    if (!target) {
      // A view without its own clear colour clears like the scene view does.
      target = createPlanarMirrorTarget(this.scene, `mirror:${surface.mesh.name}`, camera, width, height, type,
        mirrorResources, this.scene.clearColor ?? new Color4(0, 0, 0, 1));
      surface.target = target;
      surface.ready = false;
      return target;
    }
    if (resizePlanarMirrorTarget(this.scene, target, width, height, mirrorResources)) return target;
    surface.binding.texture = null;
    surface.drawn = false;
    return null;
  }

  private draw(surface: Surface, target: PlanarMirrorTargetState): boolean {
    this.drawing = true;
    this.drawSurface = surface;
    this.drawTarget = target;
    this.drew = false;
    try {
      drawPlanarMirrorPass(this.scene, target.texture, this.drawPass, DRAW_POLICY);
    } finally {
      this.drawing = false;
      this.drawSurface = null;
      this.drawTarget = null;
    }
    return this.drew;
  }
}

function ownerFor(scene: Scene): SceneMirrors {
  let owner = owners.get(scene);
  if (!owner) {
    owner = new SceneMirrors(scene);
    owners.set(scene, owner);
    scene.onDisposeObservable.addOnce(() => owners.delete(scene));
  }
  return owner;
}

/** The scene's built-in mirror surface material: the reflection times the surface's Tint, unlit. */
export function builtInMirrorMaterial(scene: Scene): NodeMaterial {
  const existing = builtInMaterials.get(scene);
  if (existing) return existing;
  const material = new NodeMaterial("mirrorSurface", scene, {
    shaderLanguage: scene.getEngine().isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
  });
  if (scene.getEngine().isWebGPU) rebindEmptiedDrawContexts(material);
  const created: NodeMaterialBlock[] = [];
  const plumbing: MaterialPlumbing = {};
  const outputs = createSurfacePlumbing("mirrorSurface", created, plumbing);
  const reflection = new MirrorReflectionBlock("mirrorSurfaceReflection", true);
  plumbing.worldPosition!.connectTo(reflection.worldPosition);
  plumbing.worldPosition!.connectTo(plumbing.clipPosition!);
  const fragment = new FragmentOutputBlock("mirrorSurfaceOutput");
  reflection.color.connectTo(fragment.rgb);
  material.addOutputNode(outputs[0]!);
  material.addOutputNode(fragment);
  material.build(false);
  material.doNotSerialize = true;
  registerClusteredUnlitMaterial(material);
  builtInMaterials.set(scene, material);
  material.onDisposeObservable.addOnce(() => { if (builtInMaterials.get(scene) === material) builtInMaterials.delete(scene); });
  return material;
}

/**
 * Creates a Mirror component's surface: a Width × Height plane facing local −Z drawing the built-in mirror material,
 * registered with the scene's mirror owner. A Material override replaces the material afterwards; clearing it (a
 * null material) restores the built-in one. A disabled Mirror's surface is hidden and never draws a reflection.
 */
export function createMirrorSurfaceMesh(scene: Scene, name: string, properties: MirrorProperties): Mesh {
  const mesh = MeshBuilder.CreatePlane(name, { width: properties.width, height: properties.height }, scene);
  // Placeholders exist before any pass binds them (allocating inside a pass would rebind its framebuffer).
  shadowSamplerPlaceholders(scene);
  const builtIn = builtInMirrorMaterial(scene);
  mesh.material = builtIn;
  mesh.onMaterialChangedObservable.add(() => { if (!mesh.material && !mesh.isDisposed()) mesh.material = builtIn; });
  mesh.setEnabled(properties.enabled);
  ownerFor(scene).add(mesh, properties);
  return mesh;
}

export function mirrorDiagnostics(scene: Scene): MirrorDiagnostics | null {
  const owner = owners.get(scene);
  return owner?.surfaces.length ? owner.diagnostics() : null;
}
