import { AbstractMesh, BoundingInfo, InstancedMesh, Material, Matrix, Mesh, MultiMaterial, NodeMaterial, PBRBaseMaterial, StandardMaterial, UniformBuffer, Vector3, type Effect, type Node, type Observer, type Scene } from "@babylonjs/core";
import { Lattice } from "@babylonjs/core/Meshes/lattice";
import { LatticePluginMaterial } from "@babylonjs/core/Meshes/lattice.material";
import { ensureNativeLatticeShadowDepthWrapper, releaseNativeLatticeShadowDepthWrapper } from "./native-lattice-shadow";
import { beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal, type ManagedRenderLease } from "./managed-render-resources";
import { isEditorHelperMesh } from "./helper-mesh";
import { materialBaseBounds, setMaterialBoundsExpansion } from "./material-bounds";
import { ensureLatticeShadowAdapter, isLatticeComponentRoot, markLatticeComponentRoot, meshLatticeBinding, releaseLatticeShadowAdapter, setLatticeBinding } from "./lattice-deformer-binding";
import { ensureLatticeDeformerPlugin } from "./lattice-deformer-native";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
export { markLatticeComponentRoot, hasMeshLatticeDeformer, bindMeshLatticeDeformer } from "./lattice-deformer-binding";

export interface LatticeDeformerConfig {
  enabled: boolean;
  resolution: readonly [number, number, number];
  strength: number;
  offsets: readonly number[];
  fitToMesh: boolean;
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}
const owners = new WeakMap<Node, LatticeOwner>();
const activeByScene = new WeakMap<Scene, Set<LatticeOwner>>();

/** Flush mutable native material slots before the coordinator's strict-ready
 * admission. Scene.render also calls it through each active owner's observer. */
export function flushSceneLatticeDeformers(scene: Scene): void {
  for (const owner of activeByScene.get(scene) ?? []) owner.beforeFrame();
}

function effective(config: LatticeDeformerConfig): boolean {
  return config.enabled && config.strength !== 0 && config.offsets.some((value) => value !== 0);
}
function validate(config: LatticeDeformerConfig): void {
  if (config.resolution.length !== 3 || config.boundsMin.length !== 3 || config.boundsMax.length !== 3 || config.resolution.some((v) => !Number.isInteger(v) || v < 2 || v > 4) ||
      !Number.isFinite(config.strength) || config.strength < 0 || config.strength > 1 || config.offsets.length > config.resolution.reduce((a, b) => a * b, 1) * 3 ||
      config.offsets.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e10) ||
      [...config.boundsMin, ...config.boundsMax].some((v) => !Number.isFinite(v) || Math.abs(v) > 1e10) ||
      (!config.fitToMesh && config.boundsMin.some((v, axis) => v >= config.boundsMax[axis]!)))
    throw new Error("Invalid lattice cage: use 2–4 points per axis, finite offsets, and nonempty bounds.");
}

/** Geometry remains shared and immutable; updates upload only 8–64 controls. */
export function setMeshLatticeDeformer(root: AbstractMesh, config: LatticeDeformerConfig | null): void {
  if (!config) { disposeMeshLatticeDeformer(root); return; }
  validate(config);
  markLatticeComponentRoot(root);
  let owner = owners.get(root);
  const created = !owner;
  if (!owner) { owner = new LatticeOwner(root); owners.set(root, owner); setLatticeBinding(root, owner); }
  try { owner.configure(config); }
  catch (error) { if (created) disposeMeshLatticeDeformer(root); throw error; }
}
export function refreshMeshLatticeDeformer(root: AbstractMesh): void { owners.get(root)?.refresh(true); }
export function disposeMeshLatticeDeformer(root: AbstractMesh): void {
  const owner = owners.get(root);
  if (!owner) return;
  owners.delete(root); setLatticeBinding(root); owner.dispose();
}

type Part = {
  minimum: Vector3; maximum: Vector3; matrixFlag: number; bounds: BoundingInfo;
  material: Material | null; slots: readonly (Material | null)[];
  materialObserver: ReturnType<AbstractMesh["onMaterialChangedObservable"]["add"]>;
};
class CageResource {
  readonly carrier: Material;
  readonly plugin: LatticePluginMaterial;
  readonly bridge: UniformBuffer;
  readonly lease: ManagedRenderLease;
  constructor(readonly root: AbstractMesh, readonly lattice: Lattice) {
    const engine = root.getEngine();
    const bytes = lattice.resolutionX * lattice.resolutionY * lattice.resolutionZ * 16;
    const lease = beginManagedRenderAllocation(engine, bytes);
    if (!lease) throw new Error("Lattice cage exceeds the managed rendering budget.");
    this.lease = lease;
    this.carrier = new Material("__latticeResource", root.getScene(), true);
    try {
      this.plugin = new LatticePluginMaterial(lattice, this.carrier);
      this.bridge = new UniformBuffer(engine, undefined, false, "latticeEffectBridge", true);
      // The stock plugin owns exactly one private texture; its public owner is
      // our unique accounting handle, without reflecting private Babylon state.
      lease.commit([{ handle: this.plugin, bytes, category: "geometry" }]);
    } catch (error) { this.carrier.dispose(); lease.release(); throw error; }
  }
  dispose(): void {
    this.bridge.dispose(); this.carrier.dispose();
    void releaseManagedRenderLeaseAfterDisposal(this.root.getEngine(), this.lease);
  }
}

class LatticeOwner {
  resource?: CageResource;
  get active(): boolean { return !!this.resource; }
  private cageKey = "";
  private config?: LatticeDeformerConfig;
  private readonly parts = new Map<AbstractMesh, Part>();
  private readonly instanceSources = new Set<Mesh>();
  private readonly nativeShadowMaterials = new Set<Material>();
  private readonly authoredShadowMaterials = new Set<Material>();
  private nextNativeMaterials?: Set<Material>;
  private nextAuthoredMaterials?: Set<Material>;
  private readonly toWorld = Matrix.Identity();
  private readonly fromWorld = Matrix.Identity();
  private bindMatrixFlag = -1;
  private readonly bindOrigin = new Vector3(Infinity, Infinity, Infinity);
  private readonly relative = Matrix.Identity();
  private readonly inverse = Matrix.Identity();
  private readonly point = Vector3.Zero();
  private readonly minimum = Vector3.Zero();
  private readonly maximum = Vector3.Zero();
  private fit?: { min: Vector3; max: Vector3 };
  private rootFlag = -1;
  private materialsDirty = false;
  private readonly disposeObserver;
  private frameObserver: Observer<Scene> | null = null;
  constructor(private readonly root: AbstractMesh) {
    this.disposeObserver = root.onDisposeObservable.add(() => disposeMeshLatticeDeformer(root));
  }
  readonly beforeFrame = (): void => {
      // MultiMaterial slot assignment has no Observable in Babylon. Compare
      // references only; unchanged frames create no cage data or GPU uploads.
      if (this.resource) for (const [mesh, part] of this.parts) {
        const material = mesh.material;
        if (material !== part.material) this.materialsDirty = true;
        if (material instanceof MultiMaterial) {
          if (material.subMaterials.length !== part.slots.length) this.materialsDirty = true;
          else for (let index = 0; index < part.slots.length; index++) if (material.subMaterials[index] !== part.slots[index]) { this.materialsDirty = true; break; }
        }
      }
      if (this.materialsDirty) this.refresh();
      if (this.resource) this.validateInstanceOwners();
      this.updateBounds(false);
  };
  configure(config: LatticeDeformerConfig): void {
    const previous = this.config;
    this.config = { ...config, resolution: [...config.resolution], offsets: [...config.offsets], boundsMin: [...config.boundsMin], boundsMax: [...config.boundsMax] };
    try { this.refresh(); }
    catch (error) { this.config = previous; throw error; }
  }
  refresh(geometryChanged = false): void {
    const config = this.config;
    if (!config) return;
    if (geometryChanged) this.fit = undefined;
    const found = new Set<AbstractMesh>();
    const visit = (node: Node) => {
      if (node !== this.root && isLatticeComponentRoot(node)) return;
      if (node instanceof AbstractMesh && !isEditorHelperMesh(node) && node.getTotalVertices() > 0) {
        found.add(node);
        if (!this.parts.has(node)) {
          const box = materialBaseBounds(node);
          this.parts.set(node, { minimum: box.minimum.clone(), maximum: box.maximum.clone(), matrixFlag: -1, bounds: new BoundingInfo(box.minimum, box.maximum), material: node.material, slots: [], materialObserver: node.onMaterialChangedObservable.add(() => { this.materialsDirty = true; }) });
          this.fit = undefined;
          this.materialsDirty = true;
        } else if (geometryChanged) {
          const base = materialBaseBounds(node), part = this.parts.get(node)!;
          part.minimum.copyFrom(base.minimum); part.maximum.copyFrom(base.maximum); part.matrixFlag = -1;
        }
      }
      for (const child of node.getChildren(undefined, true)) visit(child);
      if (node instanceof Mesh) for (const level of node.getLODLevels()) if (level.mesh && level.mesh.parent !== node) visit(level.mesh);
    };
    visit(this.root);
    for (const [mesh, part] of this.parts) if (!found.has(mesh)) { mesh.onMaterialChangedObservable.remove(part.materialObserver); setMaterialBoundsExpansion(mesh, null); this.parts.delete(mesh); this.fit = undefined; }
    this.instanceSources.clear();
    for (const mesh of this.parts.keys()) {
      const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : mesh instanceof Mesh ? mesh : undefined;
      if (source) this.instanceSources.add(source);
    }
    const wasActive = !!this.resource;
    if (!effective(config) || !this.parts.size) {
      this.resource?.dispose(); this.resource = undefined;
      this.cageKey = "";
      for (const material of this.nativeShadowMaterials) releaseNativeLatticeShadowDepthWrapper(material);
      this.nativeShadowMaterials.clear();
      for (const material of this.authoredShadowMaterials) releaseLatticeShadowAdapter(material);
      this.authoredShadowMaterials.clear();
      for (const mesh of this.parts.keys()) setMaterialBoundsExpansion(mesh, null);
    } else {
      this.validateInstanceOwners();
      const caps = this.root.getEngine().getCaps();
      if (caps.maxVertexTextureImageUnits < 1 || !caps.textureFloat || (this.root.getEngine() as { webGLVersion?: number }).webGLVersion === 1)
        throw new Error("Lattice deformation requires vertex float-texture sampling.");
      this.nextNativeMaterials = new Set();
      this.nextAuthoredMaterials = new Set();
      for (const mesh of this.parts.keys()) this.prepareMaterials(mesh.material ?? mesh.getScene().defaultMaterial);
      for (const material of this.nativeShadowMaterials) if (!this.nextNativeMaterials.has(material)) { releaseNativeLatticeShadowDepthWrapper(material); this.nativeShadowMaterials.delete(material); }
      for (const material of this.authoredShadowMaterials) if (!this.nextAuthoredMaterials.has(material)) { releaseLatticeShadowAdapter(material); this.authoredShadowMaterials.delete(material); }
      this.nextNativeMaterials = undefined;
      this.nextAuthoredMaterials = undefined;
      const bounds = config.fitToMesh ? this.fit ?? (this.fit = this.fitBounds()) : { min: Vector3.FromArray(config.boundsMin), max: Vector3.FromArray(config.boundsMax) };
      if ([...bounds.min.asArray(), ...bounds.max.asArray()].some((value) => !Number.isFinite(value) || Math.abs(value) > 1e10))
        throw new Error("Lattice fit bounds must remain within finite component coordinates ±1e10.");
      const size = bounds.max.subtract(bounds.min);
      size.maximizeInPlaceFromFloats(0.0001, 0.0001, 0.0001);
      const position = bounds.min.add(bounds.max).scaleInPlace(0.5);
      const cageKey = JSON.stringify([config.resolution, config.strength, config.offsets, size.asArray(), position.asArray()]);
      let lattice = this.resource?.lattice;
      if (!lattice || lattice.resolutionX !== config.resolution[0] || lattice.resolutionY !== config.resolution[1] || lattice.resolutionZ !== config.resolution[2]) {
        lattice = new Lattice({ resolutionX: config.resolution[0], resolutionY: config.resolution[1], resolutionZ: config.resolution[2], position, size });
        this.applyOffsets(lattice, config);
        const next = new CageResource(this.root, lattice);
        this.resource?.dispose(); this.resource = next;
      } else if (cageKey !== this.cageKey) {
        lattice.position.copyFrom(position); lattice.size.copyFrom(size); lattice.update();
        this.applyOffsets(lattice, config); this.resource!.plugin.refreshData();
      }
      this.updateBounds(cageKey !== this.cageKey);
      this.cageKey = cageKey;
    }
    if (wasActive !== !!this.resource || !!this.resource && this.materialsDirty) this.invalidateMaterials();
    for (const [mesh, part] of this.parts) {
      part.material = mesh.material;
      part.slots = mesh.material instanceof MultiMaterial ? [...mesh.material.subMaterials] : [];
    }
    this.materialsDirty = false;
    const scene = this.root.getScene();
    if (this.resource && !this.frameObserver) {
      this.frameObserver = scene.onBeforeRenderObservable.add(this.beforeFrame);
      let active = activeByScene.get(scene); if (!active) { active = new Set(); activeByScene.set(scene, active); }
      active.add(this);
    } else if (!this.resource && this.frameObserver) { scene.onBeforeRenderObservable.remove(this.frameObserver); this.frameObserver = null; activeByScene.get(scene)?.delete(this); }
  }
  private validateInstanceOwners(): void {
    for (const source of this.instanceSources) {
      if (source.instances.length === 0) continue;
      if (meshLatticeBinding(source) !== this)
        throw new Error("A lattice cage cannot span a regular-instance batch owned by different components. Use component-owned model instances or separate Mesh clones sharing geometry.");
      for (const instance of source.instances) if (meshLatticeBinding(instance) !== this)
        throw new Error("A lattice cage cannot span a regular-instance batch owned by different components. Use component-owned model instances or separate Mesh clones sharing geometry.");
    }
  }
  private invalidateMaterials(): void {
    const materials = new Set<Material>();
    for (const mesh of this.parts.keys()) for (const subMesh of mesh.subMeshes ?? []) {
      const material = subMesh.getMaterial(); if (material) materials.add(material);
    }
    // markDirty also resets frozen draw-wrapper readiness, unlike markAsDirty.
    for (const material of materials) material.markDirty(true);
    markSceneReadinessDirty(this.root.getScene());
  }
  private applyOffsets(lattice: Lattice, config: LatticeDeformerConfig): void {
    for (let z = 0; z < lattice.resolutionZ; z++) for (let y = 0; y < lattice.resolutionY; y++) for (let x = 0; x < lattice.resolutionX; x++) {
      const i = 3 * (x + lattice.resolutionX * (y + lattice.resolutionY * z));
      lattice.data[x]![y]![z]!.addInPlaceFromFloats((config.offsets[i] ?? 0) * config.strength, (config.offsets[i + 1] ?? 0) * config.strength, (config.offsets[i + 2] ?? 0) * config.strength);
    }
  }
  private prepareMaterials(material: Material): void {
    if (material instanceof MultiMaterial) { for (const part of material.subMaterials) if (part) this.prepareMaterials(part); return; }
    if (this.authoredShadowMaterials.has(material)) { this.nextAuthoredMaterials?.add(material); return; }
    if (ensureLatticeShadowAdapter(material)) {
      this.authoredShadowMaterials.add(material); this.nextAuthoredMaterials?.add(material); return;
    }
    if (!(material instanceof PBRBaseMaterial || material instanceof StandardMaterial) || material instanceof NodeMaterial)
      throw new Error(`Lattice deformation has no shader adapter for material "${material.name}".`);
    if (!ensureLatticeDeformerPlugin(material))
      throw new Error(`Lattice deformation has no qualified native adapter for material "${material.name}".`);
    this.nextNativeMaterials?.add(material);
    if (!this.nativeShadowMaterials.has(material)) {
      ensureNativeLatticeShadowDepthWrapper(material);
      this.nativeShadowMaterials.add(material);
    }
  }
  private fitBounds(): { min: Vector3; max: Vector3 } {
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    this.root.computeWorldMatrix(true).invertToRef(this.inverse);
    for (const [mesh, part] of this.parts) {
      mesh.computeWorldMatrix(true).multiplyToRef(this.inverse, this.relative);
      this.corners(part.minimum, part.maximum, (point) => { Vector3.TransformCoordinatesToRef(point, this.relative, point); min.minimizeInPlace(point); max.maximizeInPlace(point); });
    }
    return { min, max };
  }
  private corners(min: Vector3, max: Vector3, use: (point: Vector3) => void): void {
    for (let i = 0; i < 8; i++) { this.point.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z); use(this.point); }
  }
  private updateBounds(force: boolean): void {
    const lattice = this.resource?.lattice;
    if (!lattice) return;
    const rootMatrix = this.root.computeWorldMatrix();
    force ||= this.rootFlag !== rootMatrix.updateFlag; this.rootFlag = rootMatrix.updateFlag;
    for (const [mesh, part] of this.parts) {
      if (mesh.isDisposed()) continue;
      const world = mesh.computeWorldMatrix();
      if (!force && part.matrixFlag === world.updateFlag) continue;
      part.matrixFlag = world.updateFlag;
      world.invertToRef(this.inverse); rootMatrix.multiplyToRef(this.inverse, this.relative);
      this.minimum.copyFrom(part.minimum); this.maximum.copyFrom(part.maximum);
      // Trilinear interpolation stays inside the convex hull of its controls.
      // Union with original bounds retains vertices outside the cage.
      for (const plane of lattice.data) for (const row of plane) for (const control of row) {
        control.addToRef(lattice.position, this.point);
        Vector3.TransformCoordinatesToRef(this.point, this.relative, this.point);
        this.minimum.minimizeInPlace(this.point); this.maximum.maximizeInPlace(this.point);
      }
      part.bounds.reConstruct(this.minimum, this.maximum, world);
      setMaterialBoundsExpansion(mesh, part.bounds);
    }
  }
  private matrices(): void {
    const world = this.root.computeWorldMatrix();
    const origin = this.root.getScene().floatingOriginOffset;
    const x = origin?.x ?? 0, y = origin?.y ?? 0, z = origin?.z ?? 0;
    if (this.bindMatrixFlag === world.updateFlag && this.bindOrigin.equalsToFloats(x, y, z)) return;
    this.bindMatrixFlag = world.updateFlag; this.bindOrigin.set(x, y, z);
    this.toWorld.copyFrom(world).addTranslationFromFloats(-x, -y, -z);
    this.toWorld.invertToRef(this.fromWorld);
  }
  bindBuffer(buffer: UniformBuffer): void {
    this.matrices(); this.resource!.plugin.bindForSubMesh(buffer);
    buffer.updateMatrix("slateWorldToLattice", this.fromWorld);
    buffer.updateMatrix("slateLatticeToWorld", this.toWorld);
  }
  bindEffect(effect: Effect): void {
    this.resource!.bridge.bindToEffect(effect, "Lattice");
    this.bindBuffer(this.resource!.bridge);
  }
  dispose(): void {
    const wasActive = !!this.resource;
    this.root.onDisposeObservable.remove(this.disposeObserver);
    this.root.getScene().onBeforeRenderObservable.remove(this.frameObserver);
    activeByScene.get(this.root.getScene())?.delete(this);
    this.resource?.dispose(); this.resource = undefined;
    for (const material of this.nativeShadowMaterials) releaseNativeLatticeShadowDepthWrapper(material);
    this.nativeShadowMaterials.clear();
    for (const material of this.authoredShadowMaterials) releaseLatticeShadowAdapter(material);
    this.authoredShadowMaterials.clear();
    if (wasActive) this.invalidateMaterials();
    for (const [mesh, part] of this.parts) { mesh.onMaterialChangedObservable.remove(part.materialObserver); setMaterialBoundsExpansion(mesh, null); }
    this.parts.clear();
    this.instanceSources.clear();
  }
}
