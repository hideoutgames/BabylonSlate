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
import { renderSettingsOwner, sceneRenderingSettings } from "./render-settings";
import { sceneShadowDraws } from "./shadow-atlas";
import { hasStaticThinInstances } from "./shadow-material-policy";

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

/** Graph blocks that bind content which changes without a parameter edit: other views' images, text, cage deformers. */
const DYNAMIC_BLOCKS = new Set(["MirrorReflectionBlock", "TextMaterialBlock", "LatticeDeformerBlock"]);
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
    return state.changed || volatile;
  }

  dispose(): void {
    for (const record of this.records.values()) if (record.geometry) unwatchGeometry(record.geometry);
    this.records.clear();
  }

  private sceneState(scene: Scene): void {
    const state = this.state;
    state.value(sceneShadowDraws(scene));
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
    if (hasRevisionTrackedDynamicMesh(source) || hasRevisionTrackedLandscapeGeometry(source)) return volatile;
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
      if (texture instanceof Texture) {
        state.value(texture.uOffset); state.value(texture.vOffset); state.value(texture.uScale); state.value(texture.vScale);
        state.value(texture.wAng);
      }
      if (isDynamicTexture(texture)) volatile = true;
    }
    return volatile;
  }
}
