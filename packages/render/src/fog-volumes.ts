import {
  BoundingInfo,
  Camera,
  Frustum,
  Matrix,
  Plane,
  Quaternion,
  Vector3,
  type Effect,
  type Observer,
  type Node,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import type { FogVolumeBinding, FogVolumeProperties } from "@babylonslate/core";
import { setSceneFogVolumesPresent } from "./render-settings";

/** One shared ray march admits at most eight nearby visible local media. */
export const MAX_FOG_VOLUMES = 8;

export interface PreparedFogVolume {
  readonly actorId: string;
  readonly id: string;
  readonly properties: FogVolumeProperties;
  /** Maps world positions to the unit box/sphere (extent/radius 1). */
  readonly inverseWorld: Matrix;
}

type Volume = PreparedFogVolume & {
  local: Matrix;
  bounds: BoundingInfo;
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

/** CPU-only owner: local fog does not allocate geometry, textures or shadow maps. */
export class FogVolumeRenderer {
  readonly volumes: Volume[] = [];
  readonly scene: Scene;
  readonly actorId: string;
  readonly node: TransformNode;
  visible = true;
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
        valid: false,
        distance: 0,
      });
    }
    this.dirty = true;
    return true;
  }

  prepare(): boolean {
    if (!this.visible || this.node.isDisposed() || !this.node.isEnabled()) return false;
    const rootWorld = this.node.computeWorldMatrix();
    if (this.dirty || !this.rootWorld.equals(rootWorld)) {
      this.dirty = false;
      this.rootWorld.copyFrom(rootWorld);
      for (const volume of this.volumes) {
        volume.local.multiplyToRef(rootWorld, this.world);
        volume.valid = this.world.m.every(Number.isFinite) && this.world.determinant() !== 0;
        if (!volume.valid) continue;
        this.world.invertToRef(volume.inverseWorld);
        volume.valid = volume.inverseWorld.m.every(Number.isFinite);
        if (volume.valid) volume.bounds.update(this.world);
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
export function hasFogVolumes(scene: Scene): boolean {
  for (const owner of registries.get(scene)?.owners.values() ?? [])
    if (owner.visible && owner.volumes.length) return true;
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

export function clearFogVolumes(scene: Scene): void {
  const registry = registries.get(scene);
  if (!registry) return;
  for (const owner of registry.owners.values()) owner.dispose();
  registry.owners.clear();
  registry.selected.length = 0;
  updateDemand(scene);
}

/** Reuses fixed scratch storage; selection is O(authored volumes × eight). */
export function selectFogVolumes(
  scene: Scene,
  camera: Camera,
  maxDistance: number,
): readonly PreparedFogVolume[] {
  const registry = registries.get(scene);
  if (!registry) return [];
  const selected = registry.selected;
  selected.length = 0;
  const view = camera.getViewMatrix().m;
  camera.getProjectionMatrix();
  Frustum.GetPlanesToRef(camera.getTransformationMatrix(), registry.planes);
  const eye = camera.globalPosition;
  const orthographic = camera.mode === Camera.ORTHOGRAPHIC_CAMERA;
  const handedness = scene.useRightHandedSystem ? -1 : 1;
  const cameraWorld = camera.getWorldMatrix().m;
  // The shader starts orthographic rays at minZ, then normalizes inverseView's
  // forward axis. Account for that normalization if a camera parent is scaled.
  const orthographicFar = orthographic ? camera.minZ + maxDistance /
    Math.hypot(cameraWorld[8]!, cameraWorld[9]!, cameraWorld[10]!) : 0;
  for (const owner of registry.owners.values()) {
    if (!owner.prepare()) continue;
    for (const volume of owner.volumes) {
      // Use the transformed eight corners directly: a scaled sphere test can
      // underestimate bounds under sheared parent/component transforms.
      const box = volume.bounds.boundingBox;
      if (!volume.valid || !box.isInFrustum(registry.planes)) continue;
      if (orthographic) {
        let nearest = Infinity, farthest = -Infinity;
        for (const corner of box.vectorsWorld) {
          const depth = handedness * (corner.x * view[2]! + corner.y * view[6]! + corner.z * view[10]! + view[14]!);
          nearest = Math.min(nearest, depth);
          farthest = Math.max(farthest, depth);
        }
        if (farthest <= camera.minZ || nearest >= orthographicFar) continue;
      }
      const min = box.minimumWorld, max = box.maximumWorld;
      const x = Math.max(min.x - eye.x, 0, eye.x - max.x);
      const y = Math.max(min.y - eye.y, 0, eye.y - max.y);
      const z = Math.max(min.z - eye.z, 0, eye.z - max.z);
      volume.distance = x * x + y * y + z * z;
      // Orthographic rays start across a plane, not at the camera position.
      if (!orthographic && volume.distance > maxDistance * maxDistance) continue;
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

export function bindFogVolumes(effect: Effect, scene: Scene, camera: Camera, maxDistance: number): void {
  const registry = registryFor(scene);
  const volumes = selectFogVolumes(scene, camera, maxDistance);
  for (let index = 0; index < volumes.length; index++) {
    const volume = volumes[index]!;
    volume.inverseWorld.copyToArray(registry.matrices, index * 16);
    const { density, edgeFalloff, shape } = volume.properties;
    registry.parameters[index * 4] = density;
    registry.parameters[index * 4 + 1] = edgeFalloff;
    registry.parameters[index * 4 + 2] = shape === "sphere" ? 1 : 0;
  }
  effect.setInt("fogVolumeCount", volumes.length);
  effect.setMatrices("fogVolumeInverse", registry.matrices);
  effect.setFloatArray4("fogVolumeParameters", registry.parameters);
}
