import {
  CubeTexture, InstancedMesh, Matrix, Mesh, MultiMaterial, NodeMaterial, PBRMaterial, RawTexture, StandardMaterial, Texture,
  VertexBuffer, type AbstractMesh, type BaseTexture, type Geometry, type Light, type Material, type Scene,
} from "@babylonjs/core";
import { hasRevisionTrackedCableGeometry } from "./cable-mesh";
import { hasRevisionTrackedDynamicMesh } from "./dynamic-runtime-mesh";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { hasRevisionTrackedLandscapeGeometry } from "./landscape-mesh";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { materialParameterRevision } from "./material-parameters";
import { hasOwnerNotifiedGeometry } from "./geometry-revision";
import { overlayVisualStyle } from "./overlay-visual-style";
import { renderSettingsOwner, sceneRenderingSettings } from "./render-settings";
import { forEachShadowChangeSince, shadowChangeSequence, type ShadowChange } from "./shadow-change-journal";
import { hasStaticThinInstances } from "./shadow-material-policy";
import { hasPerMeshBindings, unlitBinding } from "./unlit-material-blocks";

/** Reused value snapshot: an unchanged call allocates nothing. */
class Snapshot {
  private readonly values: unknown[] = [];
  private cursor = 0;
  changed = false;
  begin(): void {
    this.cursor = 0;
    this.changed = false;
  }
  value(value: unknown): void {
    if (!Object.is(this.values[this.cursor], value)) this.changed = true;
    this.values[this.cursor++] = value;
  }
  color(color: { r: number; g: number; b: number } | null | undefined): void {
    this.value(color?.r); this.value(color?.g); this.value(color?.b);
  }
  vector(vector: { x: number; y: number; z: number } | null | undefined): void {
    this.value(vector?.x); this.value(vector?.y); this.value(vector?.z);
  }
  end(): void {
    if (this.values.length !== this.cursor) this.changed = true;
    this.values.length = this.cursor;
  }
}

type Record = {
  geometry: Geometry | null;
  world: Matrix | null;
  worldFlag: number;
  worldValue: Matrix;
  transformRevision: number;
  /** `ReflectedContent.generation` of the last call that saw the mesh. */
  seen: number;
};

/**
 * Graph blocks that bind content which changes without a parameter edit: other views' images and text. Every graph
 * Material with a world position carries a Lattice Deformer block, which deforms only a mesh with an active cage
 * (`hasMeshLatticeDeformer`, checked per mesh), so the block alone makes nothing volatile.
 */
const DYNAMIC_BLOCKS = new Set(["MirrorReflectionBlock", "TextMaterialBlock"]);
/** Stock-material texture slots and colour/scalar inputs the snapshot follows. */
const STOCK_TEXTURES = [
  "diffuseTexture", "albedoTexture", "emissiveTexture", "reflectionTexture", "opacityTexture", "bumpTexture", "ambientTexture",
  "lightmapTexture", "specularTexture", "metallicTexture", "reflectivityTexture", "microSurfaceTexture",
] as const;
const STOCK_COLORS = ["diffuseColor", "albedoColor", "emissiveColor", "specularColor", "reflectivityColor", "ambientColor", "reflectionColor"] as const;
const STOCK_SCALARS = [
  "alpha", "metallic", "roughness", "microSurface", "specularPower", "directIntensity", "emissiveIntensity", "environmentIntensity",
  "disableLighting", "backFaceCulling", "wireframe",
] as const;
/** Texture placement that changes what a draw samples (its texture matrix). */
const TEXTURE_PLACEMENT = ["uOffset", "vOffset", "uScale", "vScale", "uAng", "vAng", "wAng"] as const;
const LIGHT_SCALARS = ["range", "angle", "innerAngle", "exponent", "width", "height", "radius", "shadowEnabled", "lightmapMode"] as const;

/**
 * A texture whose content can change without the material changing: anything other than a loaded 2D or cube image (or
 * a 1×1 placeholder), such as another view's render target, a capture, a video, a dynamic or an updatable raw texture.
 */
function isDynamicTexture(texture: BaseTexture): boolean {
  const type = texture.constructor;
  if (type === Texture || type === CubeTexture) return false;
  if (type === RawTexture) {
    const size = texture.getSize();
    return size.width * size.height > 1;
  }
  return true;
}

/** Clip-space w below which a point counts as behind a shadow view's eye. */
const MIN_W = 1e-6;

/**
 * Writes into `rect` (min x, min y, max x, max y) the NDC bounds of the world box `box` (six numbers from `at`) in the
 * view-projection `m`: empty when the whole box is behind the view's eye (it neither draws into nor samples the view),
 * unbounded when only part of it is.
 */
function projectBox(m: Float64Array, box: ArrayLike<number>, at: number, rect: Float64Array): void {
  rect[0] = rect[1] = Infinity;
  rect[2] = rect[3] = -Infinity;
  let behind = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = box[at + (corner & 1 ? 3 : 0)]!, y = box[at + (corner & 2 ? 4 : 1)]!, z = box[at + (corner & 4 ? 5 : 2)]!;
    const w = x * m[3]! + y * m[7]! + z * m[11]! + m[15]!;
    if (w <= MIN_W) { behind++; continue; }
    const nx = (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!) / w, ny = (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!) / w;
    // Negated so a non-finite projection (or w) is unbounded.
    if (!(Number.isFinite(nx) && Number.isFinite(ny))) { behind = -1; break; }
    if (nx < rect[0]!) rect[0] = nx;
    if (ny < rect[1]!) rect[1] = ny;
    if (nx > rect[2]!) rect[2] = nx;
    if (ny > rect[3]!) rect[3] = ny;
  }
  if (behind === 8) {
    rect[0] = rect[1] = Infinity;
    rect[2] = rect[3] = -Infinity;
  } else if (behind !== 0) {
    rect[0] = rect[1] = -Infinity;
    rect[2] = rect[3] = Infinity;
  }
}

/** Per compiled Material and its build and parameter revision: whether its look can change on its own. */
const compiledVolatility = new WeakMap<NodeMaterial, { buildId: number; revision: number; volatile: boolean }>();

function compiledMaterialIsVolatile(material: NodeMaterial, revision: number): boolean {
  const cached = compiledVolatility.get(material);
  if (cached && cached.buildId === material.buildId && cached.revision === revision) return cached.volatile;
  // Time inputs animate every frame (Babylon's build lists them).
  const shared = Reflect.get(material, "_sharedData") as { animatedInputs?: readonly unknown[] } | undefined;
  let volatile = (shared?.animatedInputs?.length ?? 0) > 0;
  for (const block of material.attachedBlocks) if (!volatile && DYNAMIC_BLOCKS.has(block.getClassName())) volatile = true;
  if (!volatile) for (const texture of material.getActiveTextures()) if (isDynamicTexture(texture)) { volatile = true; break; }
  compiledVolatility.set(material, { buildId: material.buildId, revision, volatile });
  return volatile;
}

/**
 * Follows what a capture-style pass draws (`changed`): the meshes, each one's placement, geometry, sub-meshes,
 * visibility and material, and the scene's lights, shadows, environment, fog and render settings. Content that can
 * change without any of these (skinning, morph targets, baked or updatable vertex data, render hooks, cage deformers,
 * animated or unknown materials, textures that update in place) is volatile: every call reports a change. Allocates
 * nothing on an unchanged call; `dispose` stops watching the meshes' geometries.
 */
export class ReflectedContent {
  private readonly records = new Map<AbstractMesh, Record>();
  /** The Scene's shadow change journal as last read; -1 before the first call. */
  private shadowSequence = -1;
  private receivers: readonly AbstractMesh[] = [];
  private shadowReached = false;
  /** Scratch: a receiver's box, its rectangle, and the changed boxes' rectangles per tile (4 numbers each). */
  private readonly receiverBox = new Float64Array(6);
  private readonly receiverRect = new Float64Array(4);
  private changeRects = new Float64Array(0);
  private readonly visitShadowChange = (change: ShadowChange) => (this.shadowReached = this.shadowChangeReaches(change));
  private readonly state = new Snapshot();
  private generation = 0;
  private readonly sweep = (record: Record, mesh: AbstractMesh) => {
    if (record.seen === this.generation) return;
    if (record.geometry) unwatchGeometry(record.geometry);
    this.records.delete(mesh);
  };

  /** Whether `meshes` (the pass's list) may draw differently from the previous call. */
  changed(scene: Scene, meshes: readonly AbstractMesh[]): boolean {
    const state = this.state;
    const generation = ++this.generation;
    let volatile = false;
    state.begin();
    this.sceneState(scene);
    state.value(meshes.length);
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      state.value(mesh);
      if (this.meshState(scene, mesh, generation)) volatile = true;
    }
    state.end();
    if (this.records.size > meshes.length) this.records.forEach(this.sweep);
    const shadows = this.shadowsChanged(scene, meshes);
    return state.changed || volatile || shadows;
  }

  /**
   * Whether a shadow map pass since the last call may have changed a shadow `meshes` show: one whose changed region,
   * in some tile's drawn view, overlaps a receiver's rectangle there widened by the tile's filter reach. Depth is not
   * compared, so a caster's change reaches every receiver it lines up with in the light's view.
   */
  private shadowsChanged(scene: Scene, meshes: readonly AbstractMesh[]): boolean {
    const sequence = shadowChangeSequence(scene);
    const since = this.shadowSequence;
    this.shadowSequence = sequence;
    // The first call reports a change anyway.
    if (since < 0 || since === sequence) return false;
    this.receivers = meshes;
    this.shadowReached = false;
    const kept = forEachShadowChangeSince(scene, since, this.visitShadowChange);
    this.receivers = [];
    return !kept || this.shadowReached;
  }

  private shadowChangeReaches(change: ShadowChange): boolean {
    const region = change.region;
    if (region.empty) return false;
    const boxes = region.all ? 0 : region.count;
    const stride = 4 * boxes;
    if (this.changeRects.length < stride * change.tiles) this.changeRects = new Float64Array(stride * change.tiles);
    const rects = this.changeRects;
    for (let tile = 0; tile < change.tiles; tile++)
      for (let b = 0; b < boxes; b++) projectBox(change.views[tile]!, region.boxes, 6 * b, rects.subarray(tile * stride + 4 * b, tile * stride + 4 * b + 4));
    const box = this.receiverBox, rect = this.receiverRect;
    for (const mesh of this.receivers) {
      if (!mesh.receiveShadows) continue;
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
      // Everywhere, or a receiver whose bounds leave its thin instances out.
      if (region.all || (source instanceof Mesh && source.hasThinInstances)) return true;
      const info = mesh.getBoundingInfo();
      const min = info.boundingBox.minimumWorld, max = info.boundingBox.maximumWorld;
      box[0] = min.x; box[1] = min.y; box[2] = min.z; box[3] = max.x; box[4] = max.y; box[5] = max.z;
      for (let tile = 0; tile < change.tiles; tile++) {
        projectBox(change.views[tile]!, box, 0, rect);
        const reach = change.reaches[tile]!;
        // Outside its tile's view a receiver samples nothing of it.
        const x0 = Math.max(-1, rect[0]! - reach), y0 = Math.max(-1, rect[1]! - reach);
        const x1 = Math.min(1, rect[2]! + reach), y1 = Math.min(1, rect[3]! + reach);
        if (!(x0 <= x1 && y0 <= y1)) continue;
        for (let b = 0; b < boxes; b++) {
          const at = tile * stride + 4 * b;
          if (rects[at]! <= x1 && rects[at + 2]! >= x0 && rects[at + 1]! <= y1 && rects[at + 3]! >= y0) return true;
        }
      }
    }
    return false;
  }

  dispose(): void {
    for (const record of this.records.values()) if (record.geometry) unwatchGeometry(record.geometry);
    this.records.clear();
  }

  private sceneState(scene: Scene): void {
    const state = this.state;
    const lights = scene.lights;
    state.value(lights.length);
    for (let i = 0; i < lights.length; i++) this.lightState(lights[i]!);
    state.value(scene.lightsEnabled);
    state.value(scene.shadowsEnabled);
    state.value(scene.texturesEnabled);
    state.value(scene.forceWireframe);
    state.value(scene.useRightHandedSystem);
    state.value(scene.environmentTexture);
    state.value(scene.environmentTexture?.level);
    state.value(scene.environmentIntensity);
    state.color(scene.ambientColor);
    state.value(scene.fogEnabled);
    state.value(scene.fogMode);
    state.value(scene.fogStart);
    state.value(scene.fogEnd);
    state.value(scene.fogDensity);
    state.color(scene.fogColor);
    const image = scene.imageProcessingConfiguration;
    state.value(image.isEnabled);
    state.value(image.exposure);
    state.value(image.contrast);
    state.value(image.toneMappingEnabled);
    state.value(image.toneMappingType);
    // Writers replace these objects rather than mutate them.
    const settings = sceneRenderingSettings(renderSettingsOwner(scene));
    state.value(settings.mode);
    state.value(settings.project);
    state.value(settings.overrides);
    state.value(settings.shadowOverrides);
    state.value(settings.environmentOverrides);
    state.value(settings.runtimeOverrides);
    state.value(settings.qualityOverrides);
    state.value(settings.localQualityOverrides);
    state.value(settings.lightsDebug);
    state.value(settings.waterRevision);
  }

  private lightState(light: Light): void {
    const state = this.state;
    state.value(light);
    state.value(light.isEnabled());
    state.value(light.intensity);
    state.color(light.diffuse);
    state.color(light.specular);
    // Parented lights place themselves from their parent's world matrix.
    const placed = light as Light & { computeTransformedInformation?: () => boolean } & { [key: string]: { x: number; y: number; z: number } | undefined };
    const transformed = placed.computeTransformedInformation?.() === true;
    state.vector(transformed ? placed.transformedPosition : placed.position);
    state.vector(transformed && placed.transformedDirection ? placed.transformedDirection : placed.direction);
    state.color((light as Light & { groundColor?: { r: number; g: number; b: number } }).groundColor);
    for (const key of LIGHT_SCALARS) state.value(Reflect.get(light, key));
    state.value(light.includedOnlyMeshes.length);
    state.value(light.excludedMeshes.length);
  }

  /** Writes the mesh's state; true when its content is volatile. */
  private meshState(scene: Scene, mesh: AbstractMesh, generation: number): boolean {
    const state = this.state;
    let record = this.records.get(mesh);
    if (!record) {
      record = { geometry: null, world: null, worldFlag: -1, worldValue: Matrix.Identity(), transformRevision: 0, seen: 0 };
      this.records.set(mesh, record);
    }
    record.seen = generation;
    // An instance draws its source's geometry, deformers and material at its own world matrix.
    const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh;
    const geometry = source instanceof Mesh ? source.geometry : null;
    if (record.geometry !== geometry) {
      if (record.geometry) unwatchGeometry(record.geometry);
      record.geometry = geometry;
      if (geometry) watchGeometry(geometry);
    }
    const world = mesh.computeWorldMatrix();
    if (world !== record.world || world.updateFlag !== record.worldFlag) {
      if (!world.equals(record.worldValue)) record.transformRevision++;
      record.worldValue.copyFrom(world);
      record.world = world;
      record.worldFlag = world.updateFlag;
    }
    state.value(record.transformRevision);
    state.value(mesh.isVisible);
    state.value(mesh.visibility);
    state.value(mesh.receiveShadows);
    state.value(mesh.renderingGroupId);
    // A component's opacity and tint, bound per draw by unlit and Standard materials alike.
    const style = overlayVisualStyle(source);
    state.value(style.opacity);
    state.value(style.tint[0]); state.value(style.tint[1]); state.value(style.tint[2]); state.value(style.tint[3]);
    state.value(source instanceof Mesh ? source.sideOrientation : undefined);
    state.value(geometry);
    const watch = geometry ? geometryRevision(geometry) : null;
    state.value(watch?.revision);
    if (source instanceof Mesh && source.hasThinInstances) {
      const thin = source._thinInstanceDataStorage;
      state.value(thin.instancesCount);
      state.value(thin.matrixBuffer);
      const user = source._userThinInstanceBuffersStorage?.vertexBuffers;
      if (user) for (const kind in user) state.value(user[kind]);
    }
    const parts = source.subMeshes;
    state.value(parts);
    if (parts)
      for (const part of parts) {
        state.value(part.indexStart);
        state.value(part.indexCount);
        state.value(part.materialIndex);
      }
    const material = mesh.material ?? scene.defaultMaterial;
    let volatile = this.materialState(material);
    // An unlit Material binds each mesh's own values per draw (Babylon binds an instance as its source).
    if (hasPerMeshBindings(material) && this.unlitState(source)) volatile = true;
    if (material instanceof MultiMaterial) {
      const slots = material.subMaterials;
      state.value(slots.length);
      for (const slot of slots) if (slot && this.materialState(slot)) volatile = true;
    }
    if (
      !(source instanceof Mesh) ||
      source.skeleton ||
      source.morphTargetManager ||
      source.bakedVertexAnimationManager ||
      (source.hasThinInstances && !hasStaticThinInstances(source)) ||
      hasMeshLatticeDeformer(mesh) || (source !== mesh && hasMeshLatticeDeformer(source)) ||
      source.onBeforeRenderObservable.hasObservers() ||
      source.onBeforeDrawObservable.hasObservers() ||
      source.onBeforeBindObservable.hasObservers()
    )
      return true;
    if (!geometry) return volatile;
    // As shadow maps cache them (`ShadowMapRefresh`): vertex data changes count only through notified updates, and an
    // updatable index buffer's updates never notify, unless the mesh's owner routes every write through notified updates.
    if (!watch) return true;
    if (hasRevisionTrackedDynamicMesh(source) || hasRevisionTrackedLandscapeGeometry(source) || hasOwnerNotifiedGeometry(source)) return volatile;
    if (Reflect.get(geometry, "_indexBufferIsUpdatable") !== false) return true;
    const buffers = geometry.getVertexBuffers();
    const cable = hasRevisionTrackedCableGeometry(source);
    if (buffers)
      for (const kind in buffers)
        if (buffers[kind]?.isUpdatable() && !(cable && (kind === VertexBuffer.PositionKind || kind === VertexBuffer.NormalKind))) return true;
    return volatile;
  }

  /** Writes the material's state; true when its look can change without it. */
  private materialState(material: Material): boolean {
    const state = this.state;
    state.value(material);
    state.value(material.alpha);
    state.value(material.backFaceCulling);
    state.value(material.wireframe);
    if (material instanceof MultiMaterial) return false;
    if (hasPerMeshBindings(material)) {
      // The unlit Material's program and render state are fixed per instance; what each mesh draws is its binding
      // (`unlitState`). Its bind observer only rebinds that binding on a frozen material.
      state.value((material as NodeMaterial).buildId);
      state.value(material.fogEnabled);
      state.value((material as NodeMaterial).imageProcessingConfiguration);
      return false;
    }
    const revision = materialParameterRevision(material);
    if (revision !== undefined && material instanceof NodeMaterial) {
      state.value(material.buildId);
      state.value(revision);
      return compiledMaterialIsVolatile(material, revision);
    }
    const type = material.constructor;
    if ((type !== StandardMaterial && type !== PBRMaterial) || material.onBindObservable.hasObservers()) return true;
    for (const key of STOCK_SCALARS) state.value(Reflect.get(material, key));
    for (const key of STOCK_COLORS) state.color(Reflect.get(material, key) as { r: number; g: number; b: number } | undefined);
    let volatile = false;
    for (const key of STOCK_TEXTURES) {
      const texture = Reflect.get(material, key) as BaseTexture | null | undefined;
      state.value(texture);
      if (!texture) continue;
      state.value(texture.level);
      if (this.textureState(texture)) volatile = true;
    }
    return volatile;
  }

  /** Writes a bound texture's state; true when its content can change without it. */
  private textureState(texture: BaseTexture): boolean {
    const state = this.state;
    state.value(texture.level);
    state.value(texture.hasAlpha);
    if (texture instanceof Texture) for (const key of TEXTURE_PLACEMENT) state.value(texture[key]);
    return isDynamicTexture(texture);
  }

  /**
   * Writes what an unlit mesh binds (`bindUnlitUniforms`) besides its visual style: its binding, which owners edit in
   * place, and its vertex colours. True when its texture can change without it.
   */
  private unlitState(mesh: AbstractMesh): boolean {
    const state = this.state;
    const binding = unlitBinding(mesh);
    state.value(binding.texture);
    state.value(binding.color[0]); state.value(binding.color[1]); state.value(binding.color[2]);
    state.value(binding.alpha);
    state.value(binding.cutoff);
    state.value(binding.blend);
    state.value(binding.textureAlpha);
    state.value(binding.twoSided);
    const stroke = binding.msdf;
    state.value(stroke?.strokeColor[0]); state.value(stroke?.strokeColor[1]); state.value(stroke?.strokeColor[2]);
    state.value(stroke?.strokeWidth);
    state.value(mesh.hasVertexAlpha);
    state.value(mesh.useVertexColors);
    return !!binding.texture && this.textureState(binding.texture);
  }
}
