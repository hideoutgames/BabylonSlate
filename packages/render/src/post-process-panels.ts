import { Camera } from "@babylonjs/core/Cameras/camera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";
import type { Scene } from "@babylonjs/core/scene";
import type { SceneLayerPostProcessPanelPayload } from "@haptic/bridge";
import type { MaterialParameterValue, ScenePostProcessEntry } from "@haptic/core";
import { registerSceneAuxiliaryViews } from "./scene-auxiliary-views";
import { setUnlitMaterial, type UnlitMaterialKey } from "./unlit-material";

/**
 * The layer mask of a Post Processing Panel's content while its panel draws it: no layer camera sees it, so it draws
 * only through the panel's own view (which lists it), then reaches the layer as the panel's result.
 */
export const POST_PROCESS_PANEL_CONTENT_MASK = 0x10000000;
/** The layer mask of content a panel clips away whole (its rectangle is off screen): no camera draws it. */
export const POST_PROCESS_PANEL_HIDDEN_MASK = 0x20000000;
/** The id of a panel's single pass in the stack its view attaches. */
export const POST_PROCESS_PANEL_ENTRY_ID = "panel";

/** The panel's result drawn at its place in the layer, blended by its alpha as the shared stack's result is over the world. */
const PANEL_RESULT: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: false, role: "world" };

/** A panel's view: draws its content through its Material into its output (`createView`). */
export interface PostProcessPanelView {
  /** Draws this frame (inside the layer's own frame); false when it is not ready yet or failed. */
  render(): boolean;
  setParameter(name: string, value: MaterialParameterValue): void;
  /** Stops it; its output is released once the returned promise settles. */
  retire(): Promise<void>;
}

export interface PostProcessPanelsOptions {
  /** A slot's actor root in this Scene (`binding.meshes`), with every visual of the actor beneath it. */
  slotRoot(slotId: number): AbstractMesh | null | undefined;
  /** A view of `scene` that draws `objects` through `camera` into its output through the one-pass `stack`. */
  createView(camera: TargetCamera, objects: FrameGraphObjectList, stack: ScenePostProcessEntry[]): PostProcessPanelView;
}

/** A pixel rectangle of the layer's output, bottom-up, in whole pixels. */
export interface PostProcessPanelRect { x: number; y: number; width: number; height: number }

type PanelState = {
  spec: SceneLayerPostProcessPanelPayload;
  /** Parameter values: the payload's, then live writes; a new view starts from them. */
  values: Map<string, MaterialParameterValue>;
  view: PanelGpuView | null;
  /** This frame's rectangle; null while it is off screen. */
  rect: PostProcessPanelRect | null;
  /** What its view draws this frame. */
  objects: AbstractMesh[];
};

type PanelGpuView = {
  width: number;
  height: number;
  camera: TargetCamera;
  output: RenderTargetTexture;
  quad: Mesh;
  objectList: FrameGraphObjectList;
  renderer: PostProcessPanelView;
  /** Its output holds a drawn result: the layer shows it in place of the content. */
  presented: boolean;
  /** The view threw: its panel draws as a plain container until the panel list changes. */
  failed: boolean;
};

const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const;
const scratchCorner = new Vector3();
const scratchProjected = new Vector3();
const scratchViewProjection = new Matrix();
const scratchInverseView = new Matrix();
const scratchCentre = new Vector3();
const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const scratchPosition = new Vector3();

/** Quads drawing panel results; a Desired layer's content bounds leave them out. */
const resultQuads = new WeakSet<AbstractMesh>();

/** Whether `mesh` draws a Post Processing Panel's result rather than layer content. */
export function isPostProcessPanelResult(mesh: AbstractMesh): boolean {
  return resultQuads.has(mesh);
}

/**
 * Where a panel (its actor's centred unit square, sized by the actor's scale as a 2D Panel is) lands in the layer's
 * output: the pixels its projected corners cover, rounded outward and clamped to the output. Null when nothing of it
 * is on screen.
 */
export function postProcessPanelRect(root: AbstractMesh, camera: Camera, width: number, height: number): PostProcessPanelRect | null {
  // Moved since the last frame drew it: a pose read before the frame recomputes it.
  const world = root.computeWorldMatrix(true);
  camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), scratchViewProjection);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    Vector3.TransformCoordinatesToRef(scratchCorner.set(x, y, 0), world, scratchCorner);
    Vector3.TransformCoordinatesToRef(scratchCorner, scratchViewProjection, scratchProjected);
    const px = (scratchProjected.x + 1) / 2 * width;
    const py = (scratchProjected.y + 1) / 2 * height;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return null;
  // A hair of float error at an exact pixel edge must not grow the target by a pixel.
  const x0 = Math.max(0, Math.floor(minX + 1e-4)), y0 = Math.max(0, Math.floor(minY + 1e-4));
  const x1 = Math.min(width, Math.ceil(maxX - 1e-4)), y1 = Math.min(height, Math.ceil(maxY - 1e-4));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * A Scene Layer's Post Processing Panels. Each enabled panel with a Material draws its content (the meshes of its
 * content slots) through its own camera, which frames exactly the panel's on-screen rectangle of the layer camera's
 * view, into a target of that rectangle's size in pixels, runs its Material over it, and puts the result in the layer
 * as a quad covering the same pixels at the panel's depth, so it takes the panel's place in the layer's draw order.
 * The content then draws nowhere else (its layer mask hides it from the layer camera), and is cut to the rectangle.
 * Inner panels draw first: an outer panel's content draws an inner panel's quad. Until a panel's view has drawn once,
 * and while it cannot, its content draws as under a plain parent.
 *
 * With no panel (none sent, or post-processing off) nothing here exists: no camera, target, view, quad or Scene hook.
 */
export class ScenePostProcessPanels {
  private readonly scene: Scene;
  private readonly options: PostProcessPanelsOptions;
  private readonly panels = new Map<number, PanelState>();
  /** In draw order: inner panels first. */
  private order: PanelState[] = [];
  /** Original layer masks of the meshes this frame or an earlier one masked. */
  private readonly masked = new Map<AbstractMesh, number>();
  private releaseDrawer: (() => void) | null = null;

  constructor(scene: Scene, options: PostProcessPanelsOptions) {
    this.scene = scene;
    this.options = options;
  }

  /** Whether any panel is sent for this layer. */
  get active(): boolean {
    return this.panels.size > 0;
  }

  /** Targets the panels hold now, for diagnostics and tests. */
  views(): Array<{ slotId: number; width: number; height: number; presented: boolean; rect: PostProcessPanelRect | null }> {
    return this.order.flatMap((panel) => panel.view
      ? [{ slotId: panel.spec.slotId, width: panel.view.width, height: panel.view.height, presented: panel.view.presented, rect: panel.rect }]
      : []);
  }

  /**
   * The layer's panels as the runtime sent them (`sceneLayerPostProcessPanels`). A panel whose Material or content
   * changed keeps its view when only content moved; a new Material starts a new view. Parameter values become the
   * payload's.
   */
  set(panels: readonly SceneLayerPostProcessPanelPayload[]): void {
    const next = new Map<number, PanelState>();
    for (const spec of panels) {
      if (next.has(spec.slotId)) continue;
      const previous = this.panels.get(spec.slotId);
      const values = new Map(Object.entries(spec.parameters ?? {}));
      if (previous && previous.spec.componentId === spec.componentId && previous.spec.materialGuid === spec.materialGuid) {
        const removed = [...previous.values.keys()].some((name) => !values.has(name));
        previous.spec = spec;
        previous.values = values;
        // A value going back to its default needs the pass rebuilt from the defaults.
        if (removed) this.dropView(previous);
        else for (const [name, value] of values) previous.view?.renderer.setParameter(name, value);
        next.set(spec.slotId, previous);
        continue;
      }
      if (previous) this.dropView(previous);
      next.set(spec.slotId, { spec, values, view: null, rect: null, objects: [] });
    }
    for (const [slotId, panel] of this.panels) if (!next.has(slotId)) this.dropView(panel);
    this.panels.clear();
    for (const [slotId, panel] of next) this.panels.set(slotId, panel);
    this.order = panels.flatMap((spec) => this.panels.get(spec.slotId)?.spec === spec ? [this.panels.get(spec.slotId)!] : []);
    if (this.panels.size === 0) this.release();
  }

  /** Whether the slot holds this layer's panel with that component and Material now. */
  holds(slotId: number, componentId: string | undefined, materialGuid: string): boolean {
    const panel = this.panels.get(slotId);
    return !!panel && (componentId === undefined || panel.spec.componentId === componentId) && panel.spec.materialGuid === materialGuid;
  }

  /** A live parameter write on a panel's Material Object; false for a panel or Material that is not this layer's now. */
  setParameter(slotId: number, componentId: string | undefined, materialGuid: string, name: string, value: MaterialParameterValue): boolean {
    const panel = this.panels.get(slotId);
    if (!panel || !this.holds(slotId, componentId, materialGuid)) return false;
    panel.values.set(name, value);
    panel.view?.renderer.setParameter(name, value);
    return true;
  }

  /**
   * Before the layer draws: frames each panel with the layer camera, (re)builds the views whose size changed, and
   * decides what draws where this frame. `enabled` false (post-processing off) releases everything: the content
   * draws as under plain parents.
   */
  beforeRender(layerCamera: TargetCamera, outputWidth: number, outputHeight: number, enabled: boolean): void {
    if (!enabled || this.panels.size === 0) {
      this.releaseViews();
      return;
    }
    for (const panel of this.order) {
      const root = this.options.slotRoot(panel.spec.slotId);
      panel.rect = root && !root.isDisposed() ? postProcessPanelRect(root, layerCamera, outputWidth, outputHeight) : null;
      panel.objects = [];
      if (!panel.rect || !root) {
        // Off screen: its view keeps its target for when it returns.
        if (panel.view) panel.view.quad.setEnabled(false);
        continue;
      }
      if (panel.view && !panel.view.failed && (panel.view.width !== panel.rect.width || panel.view.height !== panel.rect.height)) this.dropView(panel);
      if (!panel.view) panel.view = this.createView(panel);
      if (!panel.view.failed) this.frame(panel.view, panel.rect, root, layerCamera, outputWidth, outputHeight);
    }
    const presented = (panel: PanelState) => !!panel.rect && !!panel.view?.presented && !panel.view.failed;
    /** The panel whose result draws `panel`'s quad: the nearest presented panel holding it. */
    const holderAbove = (panel: PanelState): PanelState | null => {
      const seen = new Set<PanelState>([panel]);
      for (let slot = panel.spec.parentSlotId; slot !== null;) {
        const outer = this.panels.get(slot);
        if (!outer || seen.has(outer)) return null;
        if (presented(outer)) return outer;
        seen.add(outer);
        slot = outer.spec.parentSlotId;
      }
      return null;
    };
    const masks = new Map<AbstractMesh, number>();
    for (const panel of this.order) {
      const meshes = this.contentMeshes(panel);
      if (!panel.rect) {
        // Clipped away whole: nothing of it shows.
        for (const mesh of meshes) masks.set(mesh, POST_PROCESS_PANEL_HIDDEN_MASK);
        continue;
      }
      if (panel.view && !panel.view.failed) panel.objects.push(...meshes);
      const holder = presented(panel) ? panel : holderAbove(panel);
      if (holder) {
        if (holder !== panel) holder.objects.push(...meshes);
        for (const mesh of meshes) masks.set(mesh, POST_PROCESS_PANEL_CONTENT_MASK);
      }
      const quad = panel.view?.quad;
      if (!quad) continue;
      quad.setEnabled(presented(panel));
      if (!presented(panel)) continue;
      const outer = holderAbove(panel);
      if (outer) {
        outer.objects.push(quad);
        masks.set(quad, POST_PROCESS_PANEL_CONTENT_MASK);
      }
    }
    this.applyMasks(masks);
    for (const panel of this.order) {
      if (panel.view) {
        panel.view.objectList.meshes = panel.objects;
      }
    }
    this.releaseDrawer ??= registerSceneAuxiliaryViews(this.scene, () => this.draw());
  }

  /** Inside the layer's frame, before its objects: each panel's view, inner first. */
  private draw(): void {
    const scene = this.scene;
    const autoClear = scene.autoClear, autoClearDepthAndStencil = scene.autoClearDepthAndStencil;
    // A panel's view clears its own targets to transparent whatever the layer's own clears are.
    scene.autoClear = true;
    scene.autoClearDepthAndStencil = true;
    try {
      for (const panel of this.order) {
        const view = panel.view;
        if (!view || view.failed || !panel.rect) continue;
        try {
          if (view.renderer.render()) view.presented = true;
        } catch (error) {
          view.failed = true;
          view.presented = false;
          view.quad.setEnabled(false);
          console.warn(`[render] Post Processing Panel ${panel.spec.slotId} draws its content plainly: ${String(error)}`);
        }
      }
    } finally {
      scene.autoClear = autoClear;
      scene.autoClearDepthAndStencil = autoClearDepthAndStencil;
    }
  }

  /** The actor roots of its content slots and every mesh beneath them. */
  private contentMeshes(panel: PanelState): AbstractMesh[] {
    const meshes: AbstractMesh[] = [];
    const seen = new Set<AbstractMesh>();
    for (const slotId of panel.spec.contentSlotIds) {
      const root = this.options.slotRoot(slotId);
      if (!root || root.isDisposed() || seen.has(root)) continue;
      seen.add(root);
      meshes.push(root);
      for (const mesh of root.getChildMeshes(false)) {
        if (seen.has(mesh) || resultQuads.has(mesh)) continue;
        seen.add(mesh);
        meshes.push(mesh);
      }
    }
    return meshes;
  }

  /** Masks this frame's meshes and gives every other mesh masked before its own mask back. */
  private applyMasks(masks: ReadonlyMap<AbstractMesh, number>): void {
    for (const [mesh, original] of this.masked) {
      if (masks.has(mesh)) continue;
      this.masked.delete(mesh);
      if (!mesh.isDisposed()) mesh.layerMask = original;
    }
    for (const [mesh, mask] of masks) {
      if (!this.masked.has(mesh)) {
        // Hidden from the camera already (a 0 mask): it stays so.
        if (mesh.layerMask === 0) continue;
        this.masked.set(mesh, mesh.layerMask);
      }
      if (mesh.layerMask !== mask) mesh.layerMask = mask;
    }
  }

  private createView(panel: PanelState): PanelGpuView {
    const { width, height } = panel.rect!;
    const scene = this.scene;
    const previous = scene.activeCamera;
    const camera = new TargetCamera(`postProcessPanelCamera:${panel.spec.slotId}`, Vector3.Zero(), scene, false);
    scene.activeCamera = previous;
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    // Its objects are listed: none is left out by its mask.
    camera.layerMask = 0xffffffff;
    const output = new RenderTargetTexture(`postProcessPanelOutput:${panel.spec.slotId}`, { width, height }, scene, {
      generateMipMaps: false, generateDepthBuffer: false, samplingMode: Texture.NEAREST_SAMPLINGMODE,
    });
    output.hasAlpha = true;
    // Only the view's graph writes it.
    output.renderList = [];
    camera.outputRenderTarget = output;
    const quad = MeshBuilder.CreatePlane(`postProcessPanelResult:${panel.spec.slotId}`, { size: 1 }, scene);
    quad.isPickable = false;
    quad.rotationQuaternion = Quaternion.Identity();
    quad.setEnabled(false);
    resultQuads.add(quad);
    setUnlitMaterial(quad, PANEL_RESULT, {
      texture: output, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: true, textureAlpha: true, twoSided: false,
    });
    const objectList: FrameGraphObjectList = { meshes: [], particleSystems: null };
    const stack: ScenePostProcessEntry[] = [{
      id: POST_PROCESS_PANEL_ENTRY_ID, materialGuid: panel.spec.materialGuid, enabled: true,
      parameters: Object.fromEntries(panel.values),
    }];
    let renderer: PostProcessPanelView;
    let failed = false;
    try {
      renderer = this.options.createView(camera, objectList, stack);
    } catch (error) {
      failed = true;
      console.warn(`[render] Post Processing Panel ${panel.spec.slotId} draws its content plainly: ${String(error)}`);
      renderer = { render: () => false, setParameter: () => {}, retire: () => Promise.resolve() };
    }
    return { width, height, camera, output, quad, objectList, renderer, presented: false, failed };
  }

  /**
   * Points the view's camera at the panel's pixels of the layer camera's view (same pose, an orthographic window of
   * those pixels) and puts the quad over the same pixels at the panel's depth.
   */
  private frame(view: PanelGpuView, rect: PostProcessPanelRect, root: AbstractMesh, layer: TargetCamera, width: number, height: number): void {
    const camera = view.camera;
    // The layer camera's pose exactly, so both cameras share one view matrix.
    camera.position.copyFrom(layer.position);
    camera.rotation.copyFrom(layer.rotation);
    if (layer.rotationQuaternion) (camera.rotationQuaternion ??= Quaternion.Identity()).copyFrom(layer.rotationQuaternion);
    else if (camera.rotationQuaternion) camera.rotationQuaternion = null as unknown as Quaternion;
    camera.upVector.copyFrom(layer.upVector);
    camera.updateUpVectorFromRotation = layer.updateUpVectorFromRotation;
    camera.minZ = layer.minZ;
    camera.maxZ = layer.maxZ;
    const left = layer.orthoLeft ?? -width / 2, right = layer.orthoRight ?? width / 2;
    const bottom = layer.orthoBottom ?? -height / 2, top = layer.orthoTop ?? height / 2;
    const spanX = (right - left) / width, spanY = (top - bottom) / height;
    camera.orthoLeft = left + rect.x * spanX;
    camera.orthoRight = left + (rect.x + rect.width) * spanX;
    camera.orthoBottom = bottom + rect.y * spanY;
    camera.orthoTop = bottom + (rect.y + rect.height) * spanY;
    const viewMatrix = layer.getViewMatrix();
    viewMatrix.invertToRef(scratchInverseView);
    Vector3.TransformCoordinatesToRef(root.getAbsolutePosition(), viewMatrix, scratchCentre);
    scratchCentre.set(left + (rect.x + rect.width / 2) * spanX, bottom + (rect.y + rect.height / 2) * spanY, scratchCentre.z);
    Vector3.TransformCoordinatesToRef(scratchCentre, scratchInverseView, scratchPosition);
    scratchInverseView.decompose(scratchScale, scratchRotation);
    const quad = view.quad;
    if (!quad.position.equals(scratchPosition)) quad.position.copyFrom(scratchPosition);
    if (!quad.rotationQuaternion!.equals(scratchRotation)) quad.rotationQuaternion!.copyFrom(scratchRotation);
    scratchScale.set(rect.width * spanX, rect.height * spanY, 1);
    if (!quad.scaling.equals(scratchScale)) quad.scaling.copyFrom(scratchScale);
  }

  private dropView(panel: PanelState): void {
    const view = panel.view;
    if (!view) return;
    panel.view = null;
    resultQuads.delete(view.quad);
    this.masked.delete(view.quad);
    view.quad.dispose();
    const camera = view.camera;
    camera.outputRenderTarget = null;
    void view.renderer.retire().catch(() => {}).then(() => {
      view.output.dispose();
      camera.dispose();
    });
  }

  private releaseViews(): void {
    for (const panel of this.panels.values()) {
      this.dropView(panel);
      panel.rect = null;
      panel.objects = [];
    }
    this.applyMasks(new Map());
    this.releaseDrawer?.();
    this.releaseDrawer = null;
  }

  /** Every view, mask and hook goes: the layer's content draws as it would without panels. */
  release(): void {
    this.releaseViews();
  }

  /** A restored graphics context: the views are built again with the next frame. */
  invalidate(): void {
    this.releaseViews();
  }

  /**
   * Whether a pick at output pixel (`x`, `y` from the top) may hit `mesh`: content a panel draws is hit only inside
   * that panel's rectangle and those of the panels holding it, as it shows; content clipped away whole is never hit.
   */
  allowsPick(mesh: AbstractMesh, x: number, y: number, outputHeight: number): boolean {
    if (this.masked.size === 0 || !this.masked.has(mesh)) return true;
    if (mesh.layerMask === POST_PROCESS_PANEL_HIDDEN_MASK) return false;
    if (mesh.layerMask !== POST_PROCESS_PANEL_CONTENT_MASK) return true;
    const bottomUp = outputHeight - y;
    const inside = (rect: PostProcessPanelRect) =>
      x >= rect.x && x < rect.x + rect.width && bottomUp >= rect.y && bottomUp < rect.y + rect.height;
    for (const panel of this.order) {
      if (!panel.rect || !panel.view?.presented || !panel.objects.includes(mesh)) continue;
      const seen = new Set<PanelState>();
      for (let current: PanelState | undefined = panel; current && !seen.has(current);) {
        seen.add(current);
        if (current.rect && current.view?.presented && !inside(current.rect)) return false;
        current = current.spec.parentSlotId === null ? undefined : this.panels.get(current.spec.parentSlotId);
      }
      return true;
    }
    return true;
  }
}
