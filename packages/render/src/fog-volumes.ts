import type { Camera } from "@babylonjs/core/Cameras/camera";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import type { FogVolumeBinding, FogVolumeProperties } from "@haptic/core";
import { setSceneFogVolumesPresent } from "./render-settings";

/** One shared ray march admits at most eight nearby visible local media. */
export const MAX_FOG_VOLUMES = 8;

interface PreparedFogVolume {
  readonly actorId: string;
  readonly id: string;
  readonly properties: FogVolumeProperties;
  /** Maps world positions to the unit box/sphere (extent/radius 1). */
  readonly inverseWorld: Matrix;
}

type Volume = PreparedFogVolume & {
  local: Matrix;
  bounds: BoundingInfo;
  /** Sphere about the volume's world centre holding all eight corners; set with `bounds` while `valid`. */
  center: Vector3;
  radius: number;
  valid: boolean;
  distance: number;
};

type Registry = {
  owners: Map<string, FogVolumeRenderer>;
  selected: Volume[];
  planes: Plane[];
  matrices: Float32Array;
  parameters: Float32Array;
};

const registries = new WeakMap<Scene, Registry>();

function registryFor(scene: Scene): Registry {
  let registry = registries.get(scene);
  if (registry) return registry;
  registry = {
    owners: new Map(),
    selected: [],
    planes: Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0)),
    matrices: new Float32Array(MAX_FOG_VOLUMES * 16),
    parameters: new Float32Array(MAX_FOG_VOLUMES * 4),
  };
  registries.set(scene, registry);
  scene.onDisposeObservable.addOnce(() => {
    clearFogVolumes(scene);
    registries.delete(scene);
  });
  return registry;
}

/**
 * Babylon's own bounding sphere scales by the longest axis only, which sheared parent/component
 * transforms can outgrow. The unit box is centred on the origin, so its world centre is the
 * matrix translation; the radius is the exact distance to the farthest transformed corner.
 */
function encloseVolume(volume: Volume, world: Matrix): void {
  const center = volume.center.copyFromFloats(world.m[12]!, world.m[13]!, world.m[14]!);
  let farthest = 0;
  for (const corner of volume.bounds.boundingBox.vectorsWorld) farthest = Math.max(farthest, Vector3.DistanceSquared(corner, center));
  volume.radius = Math.sqrt(farthest);
}

/**
 * -1 when the sphere lies wholly outside one plane, 1 when wholly inside every plane, else 0.
 * The margin absorbs float rounding, so a verdict never contradicts the exact corner test:
 * -1 implies every corner is behind that plane and 1 implies every corner is in front of all.
 */
function sphereFrustumSide(planes: readonly Plane[], center: Vector3, radius: number): -1 | 0 | 1 {
  const reach = radius + radius * 1e-6 + 1e-4;
  let inside = true;
  for (let index = 0; index < planes.length; index++) {
    const distance = planes[index]!.dotCoordinate(center);
    if (distance < -reach) return -1;
    // Negated so a NaN distance falls back to the corner test.
    if (!(distance >= reach)) inside = false;
  }
  return inside ? 1 : 0;
}

/** CPU-only owner: local fog does not allocate geometry, textures or shadow maps. */
class FogVolumeRenderer {
  readonly volumes: Volume[] = [];
  readonly scene: Scene;
  readonly actorId: string;
  readonly node: TransformNode;
  visible = true;
  admitted = true;
  private readonly rootWorld = Matrix.Identity();
  private readonly world = Matrix.Identity();
  private readonly part = Matrix.Identity();
  private signature = "";
  private dirty = true;
  private readonly disposed: Observer<Node>;

  constructor(
    scene: Scene,
    actorId: string,
    node: TransformNode,
  ) {
    this.scene = scene;
    this.actorId = actorId;
    this.node = node;
    this.disposed = node.onDisposeObservable.add(() => removeFogVolumes(scene, actorId));
  }

  update(bindings: readonly FogVolumeBinding[]): boolean {
    const signature = JSON.stringify(bindings);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.volumes.length = 0;
    for (const binding of bindings) {
      const properties = binding.properties;
      if (binding.error || !properties.enabled || properties.density <= 0) continue;
      const local = Matrix.Scaling(properties.size[0] / 2, properties.size[1] / 2, properties.size[2] / 2);
      for (const transform of binding.transforms) {
        Matrix.ComposeToRef(
          Vector3.FromArray(transform.scale),
          Quaternion.FromArray(transform.rotation),
          Vector3.FromArray(transform.position),
          this.part,
        );
        local.multiplyToRef(this.part, local);
      }
      this.volumes.push({
        actorId: this.actorId,
        id: binding.id,
        properties,
        local,
        inverseWorld: Matrix.Identity(),
        bounds: new BoundingInfo(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        center: Vector3.Zero(),
        radius: 0,
        valid: false,
        distance: 0,
      });
    }
    this.dirty = true;
    return true;
  }

  prepare(): boolean {
    if (!this.admitted || !this.visible || this.node.isDisposed() || !this.node.isEnabled()) return false;
    // Babylon's same-frame shortcut precedes its dirty-ancestor check. Refresh
    // only changed hierarchies so edits bind immediately without losing caching.
    const rootWorld = this.node.computeWorldMatrix(!this.node.isSynchronized());
    if (this.dirty || !this.rootWorld.equals(rootWorld)) {
      this.dirty = false;
      this.rootWorld.copyFrom(rootWorld);
      for (const volume of this.volumes) {
        volume.local.multiplyToRef(rootWorld, this.world);
        volume.valid = this.world.m.every(Number.isFinite) && this.world.determinant() !== 0;
        if (!volume.valid) continue;
        this.world.invertToRef(volume.inverseWorld);
        volume.valid = volume.inverseWorld.m.every(Number.isFinite);
        if (volume.valid) { volume.bounds.update(this.world); encloseVolume(volume, this.world); }
      }
    }
    return true;
  }

  dispose(): void {
    this.node.onDisposeObservable.remove(this.disposed);
    this.volumes.length = 0;
  }
}

/** True for authored active sources, independent of camera visibility. */
export function hasFogVolumes(scene: Scene, actorId?: string): boolean {
  if (actorId !== undefined) {
    const owner = registries.get(scene)?.owners.get(actorId);
    return Boolean(owner?.admitted && owner.visible && owner.volumes.length);
  }
  for (const owner of registries.get(scene)?.owners.values() ?? [])
    if (owner.admitted && owner.visible && owner.volumes.length) return true;
  return false;
}

function updateDemand(scene: Scene): void {
  if (!scene.isDisposed) setSceneFogVolumesPresent(scene, hasFogVolumes(scene));
}

export function upsertFogVolumes(
  scene: Scene,
  actorId: string,
  node: TransformNode,
  bindings: readonly FogVolumeBinding[],
  admitted = true,
): boolean {
  if (!bindings.length || node.isDisposed()) return removeFogVolumes(scene, actorId);
  const registry = registryFor(scene);
  let owner = registry.owners.get(actorId);
  let changed = false;
  if (!owner || owner.node !== node) {
    const visible = owner?.visible ?? true;
    owner?.dispose();
    owner = new FogVolumeRenderer(scene, actorId, node);
    owner.visible = visible;
    registry.owners.set(actorId, owner);
    changed = true;
  }
  if (owner.admitted !== admitted) { owner.admitted = admitted; changed = true; }
  changed = owner.update(bindings) || changed;
  if (changed) updateDemand(scene);
  return changed;
}

export function removeFogVolumes(scene: Scene, actorId: string): boolean {
  const registry = registries.get(scene);
  const owner = registry?.owners.get(actorId);
  if (!owner) return false;
  owner.dispose();
  registry!.owners.delete(actorId);
  updateDemand(scene);
  return true;
}

/** Actor visibility is separate from invisible editor/Play helper geometry. */
export function setFogVolumesVisible(scene: Scene, actorId: string, visible: boolean): void {
  const owner = registries.get(scene)?.owners.get(actorId);
  if (!owner || owner.visible === visible) return;
  owner.visible = visible;
  updateDemand(scene);
}

function clearFogVolumes(scene: Scene): void {
  const registry = registries.get(scene);
  if (!registry) return;
  for (const owner of registry.owners.values()) owner.dispose();
  registry.owners.clear();
  registry.selected.length = 0;
  updateDemand(scene);
}

/**
 * The nearest eight volumes in the camera's frustum. Volumetric Distance does not limit them: the march fogs a
 * volume up to the visible surface at any distance. Reuses fixed scratch storage; selection is O(authored volumes × eight).
 */
export function selectFogVolumes(
  scene: Scene,
  camera: Camera,
): readonly PreparedFogVolume[] {
  const registry = registries.get(scene);
  if (!registry) return [];
  const selected = registry.selected;
  selected.length = 0;
  camera.getViewMatrix();
  camera.getProjectionMatrix();
  // The near and far planes bound the march too: it runs from the near plane to the visible surface.
  Frustum.GetPlanesToRef(camera.getTransformationMatrix(), registry.planes);
  const eye = camera.globalPosition;
  for (const owner of registry.owners.values()) {
    if (!owner.prepare()) continue;
    for (const volume of owner.volumes) {
      // The exact test uses the transformed eight corners directly: a scaled sphere test can
      // underestimate bounds under sheared parent/component transforms. The cached enclosing
      // sphere settles volumes clearly outside or inside with six dot products and leaves only
      // those straddling a plane to the corner test.
      const box = volume.bounds.boundingBox;
      if (!volume.valid) continue;
      const side = sphereFrustumSide(registry.planes, volume.center, volume.radius);
      if (side < 0 || (side === 0 && !box.isInFrustum(registry.planes))) continue;
      const min = box.minimumWorld, max = box.maximumWorld;
      const x = Math.max(min.x - eye.x, 0, eye.x - max.x);
      const y = Math.max(min.y - eye.y, 0, eye.y - max.y);
      const z = Math.max(min.z - eye.z, 0, eye.z - max.z);
      volume.distance = x * x + y * y + z * z;
      let index = 0;
      while (index < selected.length) {
        const other = selected[index]!;
        if (volume.distance < other.distance ||
          (volume.distance === other.distance &&
            (volume.actorId < other.actorId || (volume.actorId === other.actorId && volume.id < other.id)))) break;
        index++;
      }
      if (index < MAX_FOG_VOLUMES) {
        const last = Math.min(selected.length, MAX_FOG_VOLUMES - 1);
        for (let shift = last; shift > index; shift--) selected[shift] = selected[shift - 1]!;
        selected[index] = volume;
      }
    }
  }
  return selected;
}

/** Binds the selected volumes and returns how far from the eye the farthest of them reaches (0 without any). */
export function bindFogVolumes(effect: Effect, scene: Scene, camera: Camera): number {
  const registry = registryFor(scene);
  selectFogVolumes(scene, camera);
  const volumes = registry.selected;
  let reach = 0;
  for (let index = 0; index < volumes.length; index++) {
    const volume = volumes[index]!;
    reach = Math.max(reach, Math.sqrt(volume.distance) + 2 * volume.radius);
    volume.inverseWorld.copyToArray(registry.matrices, index * 16);
    const { density, edgeFalloff, shape } = volume.properties;
    registry.parameters[index * 4] = density;
    registry.parameters[index * 4 + 1] = edgeFalloff;
    registry.parameters[index * 4 + 2] = shape === "sphere" ? 1 : 0;
  }
  effect.setInt("fogVolumeCount", volumes.length);
  effect.setMatrices("fogVolumeInverse", registry.matrices);
  effect.setFloatArray4("fogVolumeParameters", registry.parameters);
  return reach;
}
