import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import type { FrameGraphObjectList } from "@babylonjs/core/FrameGraph/frameGraphObjectList";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import { FrameGraphTask } from "@babylonjs/core/FrameGraph/frameGraphTask";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import type { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Material } from "@babylonjs/core/Materials/material";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Node } from "@babylonjs/core/node";
import type { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";
import { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import type { Scene } from "@babylonjs/core/scene";
import {
  DEFAULT_DECAL_PROPERTIES,
  isQualityLevel,
  type DecalBinding,
  type DecalProperties,
  type DynamicDecalSpawnRequest,
  type MaterialParameterValue,
} from "@haptic/core";
import { DECAL_INSTANCE_ATTRIBUTES, DECAL_PASS_UNIFORMS, DECAL_SCENE_DEPTH_SAMPLER } from "./decal-projection-block";
import { isDisposedNodeMaterial } from "./gpu-resource-live";
import { resolveSceneRenderingQuality, sceneRenderingSettings } from "./render-settings";
import { ManagedShadowObjectRendererTask } from "./framegraph-managed-shadows";
import { createHeldThreadBound, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import { renewOnCompileProgress } from "./driver-compile";

/** A Material Instance's own values for a decal's Material: a private copy under `key` (`MaterialLibrary.resolve`). */
export interface DecalMaterialInstance {
  key: string;
  parameters: ReadonlyMap<string, MaterialParameterValue>;
}

/**
 * Where a Scene's decals get their Decal-domain Materials: the Material asset (or Material Instance asset) by guid, or a
 * private copy with a component's own values. Null while there is none; the host asks again on `refreshDecalMaterials`.
 */
export interface DecalMaterialSource {
  resolve(guid: string, instance?: DecalMaterialInstance): Material | null;
  /** Releases a private copy the host no longer draws. */
  release?(key: string, guid: string): void;
}

/** One Material a Scene's decals draw with: the asset's, or a component's private copy. */
type DecalMaterialEntry = {
  key: string;
  guid: string;
  instance: DecalMaterialInstance | null;
  material: NodeMaterial | null;
  /** The host's material revision the entry last resolved at. */
  revision: number;
};

type PreparedDecal = {
  world: Matrix;
  inverseWorld: Matrix;
  center: Vector3;
  radius: number;
  /** Negative world determinant: the unit cube's winding flips, so its batch culls the other face (`render`). */
  mirrored: boolean;
  properties: DecalProperties;
  opacityMultiplier: number;
  material: DecalMaterialEntry | null;
};

type AuthoredDecalEntry = PreparedDecal & {
  id: string;
  local: Matrix;
  bounds: BoundingInfo;
  valid: boolean;
  /** The component's own parameter values (`DecalBinding.materialInstance`), as a signature. */
  instanceSignature: string;
  instanceParameters: ReadonlyMap<string, MaterialParameterValue> | null;
};

type DynamicDecalEntry = PreparedDecal & {
  age: number;
  lifetime: number;
  fadeOutDuration: number;
};

type DecalBatch = {
  key: string;
  sortOrder: number;
  mirrored: boolean;
  material: NodeMaterial;
  items: PreparedDecal[];
};

/**
 * The box one Material's decals draw: a unit cube outside `scene.meshes` (picking, culling, shadows and readiness
 * ignore it), thin-instanced with the decals' rows. One per Material, so each keeps its own submesh Effect and the
 * Material's defines never thrash between batches.
 */
type DecalDrawSlot = {
  material: NodeMaterial;
  cube: Mesh;
  capacity: number;
  world: Float32Array;
  rows: Record<(typeof DECAL_INSTANCE_ATTRIBUTES)[number], Float32Array>;
  /** The Effect whose compile already asks for a redraw. */
  awaited: Effect | null;
};

export interface SceneDecalStats {
  authored: number;
  dynamic: number;
  visible: number;
  batches: number;
  draws: number;
  capacity: number;
  /** Batches the last render skipped because their Material's program was not ready. */
  pending: number;
  /** Materials with a draw slot (one program each per variant). */
  materials: number;
}

const IDENTITY = Matrix.Identity();
const DECAL_PROXY_PREFIX = "haptic:decal-unit-cube";

/** Whether `mesh` is a decal pass's box (the light block keeps Screen-Space Shadows out of it). */
export function isDecalProxyMesh(mesh: AbstractMesh | null | undefined): boolean {
  return !!mesh && mesh.name.startsWith(DECAL_PROXY_PREFIX);
}

function encloseDecal(entry: AuthoredDecalEntry, world: Matrix): void {
  const center = entry.center.copyFromFloats(world.m[12]!, world.m[13]!, world.m[14]!);
  let farthest = 0;
  for (const corner of entry.bounds.boundingBox.vectorsWorld) {
    farthest = Math.max(farthest, Vector3.DistanceSquared(corner, center));
  }
  entry.radius = Math.sqrt(farthest);
}

function sphereFrustumSide(planes: readonly Plane[], center: Vector3, radius: number): -1 | 0 | 1 {
  const reach = radius + radius * 1e-6 + 1e-4;
  let inside = true;
  for (let index = 0; index < planes.length; index++) {
    const distance = planes[index]!.dotCoordinate(center);
    if (distance < -reach) return -1;
    if (!(distance >= reach)) inside = false;
  }
  return inside ? 1 : 0;
}

/**
 * Capacity of the dynamic decal pool: 64 on the Low and Medium Geometry tiers, 128 on High and Ultra. The tier is the
 * Geometry quality's target (`profile`), else the tier its values match, else Medium, as Auto local lights pick theirs.
 */
export function maxDynamicDecalsForScene(scene: Scene): number {
  const geometry = resolveSceneRenderingQuality(scene).geometry;
  const tier = geometry.profile ?? (isQualityLevel(geometry.preset) ? geometry.preset : "medium");
  return tier === "high" || tier === "ultra" ? 128 : 64;
}

/** `world` with the floating origin's eye taken from its translation (the engine's rule for an instance row). */
function writeRelativeWorld(world: Matrix, eye: Vector3, out: Float32Array, offset: number): void {
  world.copyToArray(out, offset);
  out[offset + 12] = world.m[12]! - eye.x;
  out[offset + 13] = world.m[13]! - eye.y;
  out[offset + 14] = world.m[14]! - eye.z;
}

function parameterMap(binding: DecalBinding): ReadonlyMap<string, MaterialParameterValue> | null {
  const parameters = binding.materialInstance?.parameters;
  if (!parameters) return null;
  const entries = Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? new Map(entries) : null;
}

class DecalActorOwner {
  readonly decals: AuthoredDecalEntry[] = [];
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

  constructor(scene: Scene, actorId: string, node: TransformNode) {
    this.scene = scene;
    this.actorId = actorId;
    this.node = node;
    this.disposed = node.onDisposeObservable.add(() => removeDecals(scene, actorId));
  }

  update(bindings: readonly DecalBinding[]): boolean {
    const signature = JSON.stringify(bindings);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.decals.length = 0;
    for (const binding of bindings) {
      const properties = binding.properties;
      if (binding.error || !properties.enabled || !properties.materialGuid || properties.opacity <= 0) continue;
      // Unit cube spans [-0.5, 0.5]^3 so scaling by size maps it directly to the OBB.
      const local = Matrix.Scaling(properties.size[0], properties.size[1], properties.size[2]);
      for (const transform of binding.transforms) {
        Matrix.ComposeToRef(
          Vector3.FromArray(transform.scale),
          Quaternion.FromArray(transform.rotation),
          Vector3.FromArray(transform.position),
          this.part,
        );
        local.multiplyToRef(this.part, local);
      }
      const instanceParameters = parameterMap(binding);
      this.decals.push({
        id: binding.id,
        properties,
        opacityMultiplier: 1,
        local,
        world: Matrix.Identity(),
        inverseWorld: Matrix.Identity(),
        bounds: new BoundingInfo(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5)),
        center: Vector3.Zero(),
        radius: 0,
        mirrored: false,
        valid: false,
        material: null,
        instanceParameters,
        instanceSignature: instanceParameters ? JSON.stringify([...instanceParameters]) : "",
      });
    }
    this.dirty = true;
    return true;
  }

  prepare(): boolean {
    if (!this.admitted || !this.visible || this.node.isDisposed() || !this.node.isEnabled()) return false;
    const rootWorld = this.node.computeWorldMatrix(!this.node.isSynchronized());
    if (this.dirty || !this.rootWorld.equals(rootWorld)) {
      this.dirty = false;
      this.rootWorld.copyFrom(rootWorld);
      for (const decal of this.decals) {
        decal.local.multiplyToRef(rootWorld, this.world);
        decal.world.copyFrom(this.world);
        const determinant = this.world.determinant();
        decal.valid = Math.abs(determinant) > 1e-8;
        if (!decal.valid) continue;
        decal.mirrored = determinant < 0;
        this.world.invertToRef(decal.inverseWorld);
        decal.bounds.update(this.world);
        encloseDecal(decal, this.world);
      }
    }
    return this.decals.length > 0;
  }

  dispose(): void {
    this.node.onDisposeObservable.remove(this.disposed);
  }
}

export class SceneDecalHost {
  readonly scene: Scene;
  readonly owners = new Map<string, DecalActorOwner>();
  /** Live dynamic decals, oldest first: expired ones leave at once, so a full pool evicts its front. */
  private readonly dynamicPool: DynamicDecalEntry[] = [];
  /**
   * Set by the first Spawn Decal (or a load's warm-up of Decal Materials) and kept until `clear`: the forward graph
   * keeps its decal pass while it is set, so a scene spawning short-lived decals never rebuilds the graph as its pool
   * empties and fills again.
   */
  private dynamicDemand = false;
  /** Dynamic decals left the pool since the last prune: their Materials may now be unused. */
  private dynamicReleased = false;
  private paused = false;
  private timeScale = 1;
  /** The Engine frame whose time the dynamic lifetimes last took (`advanceClock`). */
  private clockFrame = -1;
  private materialSource: DecalMaterialSource | null = null;
  private readonly materialEntries = new Map<string, DecalMaterialEntry>();
  /** Bumped by `refreshMaterials`: an entry whose Material was disposed resolves again once per revision. */
  private materialRevision = 0;
  private nextInstance = 0;
  private readonly slots = new Map<NodeMaterial, DecalDrawSlot>();
  /** Warmed Materials whose program has not drawn yet: the next decal pass draws each once, degenerate. */
  private readonly firstDraws = new Set<NodeMaterial>();
  private onPending: (() => void) | null = null;
  private readonly planes: Plane[] = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  private readonly viewProjection = Matrix.Identity();
  private readonly invViewProjection = Matrix.Identity();
  private readonly relativeView = Matrix.Identity();
  private readonly eyeTranslation = Matrix.Identity();
  private readonly cameraRelative = new Vector3();
  private readonly batches: DecalBatch[] = [];
  private readonly batchMap = new Map<string, DecalBatch>();
  private lastVisibleCount = 0;
  private lastPending = 0;
  private totalDraws = 0;
  private preparedFrameId = -1;
  private preparedCamera: Camera | null = null;
  private lastPreparedResult = false;
  private demandRevision = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    scene.onDisposeObservable.addOnce(() => this.dispose());
  }

  get revision(): number {
    return this.demandRevision;
  }

  /** Where the decals' Materials come from; each decal asks it again. */
  setMaterialSource(source: DecalMaterialSource | null): void {
    this.releaseEntries();
    this.materialSource = source;
    this.relinkDecals();
  }

  /** Called when a decal was skipped because its Material's program was not ready yet, so the view draws again. */
  setPendingListener(listener: (() => void) | null): void {
    this.onPending = listener;
  }

  /**
   * Ask the source again for every Material the decals draw with: a Material document changed, or a generation was
   * published. A disposed generation's decals also ask again once after this.
   */
  refreshMaterials(): void {
    this.materialRevision += 1;
    for (const entry of this.materialEntries.values()) this.resolveEntry(entry);
  }

  /** Whether the forward graph needs its decal pass: authored decals, or any Spawn Decal since the last `clear`. */
  hasAnyDecals(): boolean {
    if (this.dynamicDemand) return true;
    for (const owner of this.owners.values()) {
      if (owner.decals.length > 0) return true;
    }
    return false;
  }

  /** Holds dynamic lifetimes while the game is paused, as particles hold. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** The simulation time scale (slomo; 0 holds lifetimes like pause), as particles take it. */
  setTimeScale(scale: number): void {
    this.timeScale = Number.isFinite(scale) ? Math.max(0, scale) : 1;
  }

  upsertActor(actorId: string, node: TransformNode, bindings: readonly DecalBinding[], admitted = true): void {
    const existing = this.owners.get(actorId);
    const has = bindings.some((binding) => !binding.error && binding.properties.enabled && !!binding.properties.materialGuid && binding.properties.opacity > 0);
    if (!has) {
      if (existing) {
        existing.dispose();
        this.owners.delete(actorId);
        this.demandRevision += 1;
        this.pruneEntries();
      }
      return;
    }
    let owner = existing;
    if (!owner || owner.node !== node) {
      owner?.dispose();
      owner = new DecalActorOwner(this.scene, actorId, node);
      this.owners.set(actorId, owner);
      this.demandRevision += 1;
    }
    owner.admitted = admitted;
    if (owner.update(bindings)) {
      this.demandRevision += 1;
      this.linkOwner(owner);
      this.pruneEntries();
    }
  }

  setActorVisible(actorId: string, visible: boolean): void {
    const owner = this.owners.get(actorId);
    if (owner) owner.visible = visible;
  }

  removeActor(actorId: string): void {
    const owner = this.owners.get(actorId);
    if (!owner) return;
    owner.dispose();
    this.owners.delete(actorId);
    this.demandRevision += 1;
    this.pruneEntries();
  }

  clear(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
    this.dynamicPool.length = 0;
    this.dynamicDemand = false;
    this.dynamicReleased = false;
    this.batches.length = 0;
    this.lastVisibleCount = 0;
    this.demandRevision += 1;
    this.firstDraws.clear();
    this.pruneEntries();
  }

  /** The entry of `guid` (shared) or of a private copy keyed by `instanceKey`, resolving a new one. */
  private entryFor(guid: string, instance: DecalMaterialInstance | null): DecalMaterialEntry {
    const key = instance ? `${guid}\u0000${instance.key}` : guid;
    let entry = this.materialEntries.get(key);
    if (!entry) {
      entry = { key, guid, instance, material: null, revision: -1 };
      this.materialEntries.set(key, entry);
      this.resolveEntry(entry);
    }
    return entry;
  }

  /** Only a Decal-domain Material draws: any other Material, or none, leaves its decals undrawn. */
  private resolveEntry(entry: DecalMaterialEntry): void {
    entry.revision = this.materialRevision;
    const material = this.materialSource?.resolve(entry.guid, entry.instance ?? undefined) ?? null;
    const usable = material instanceof NodeMaterial && (material.metadata as { materialDomain?: unknown } | null)?.materialDomain === "decal"
      ? material : null;
    if (usable !== entry.material) this.dropSlot(entry.material);
    entry.material = usable;
  }

  /** The Material `entry` draws now; a disposed generation asks the source again once per material revision. */
  private materialOf(entry: DecalMaterialEntry | null): NodeMaterial | null {
    if (!entry) return null;
    if (entry.material && !isDisposedNodeMaterial(entry.material, this.scene)) return entry.material;
    if (entry.revision !== this.materialRevision) this.resolveEntry(entry);
    else if (entry.material) { this.dropSlot(entry.material); entry.material = null; }
    return entry.material;
  }

  private linkOwner(owner: DecalActorOwner): void {
    for (const decal of owner.decals) {
      const guid = decal.properties.materialGuid!;
      let instance: DecalMaterialInstance | null = null;
      if (decal.instanceParameters) {
        // A component's own values keep their private copy while they stay the same; new values take a new copy.
        const previous = [...this.materialEntries.values()].find((entry) => entry.guid === guid &&
          entry.instance?.key.startsWith(`decal:${owner.actorId}:${decal.id}:`) && JSON.stringify([...entry.instance.parameters]) === decal.instanceSignature);
        instance = previous?.instance ?? { key: `decal:${owner.actorId}:${decal.id}:${++this.nextInstance}`, parameters: decal.instanceParameters };
      }
      decal.material = this.entryFor(guid, instance);
    }
  }

  /** Every decal asks its (new) source again. */
  private relinkDecals(): void {
    for (const owner of this.owners.values()) this.linkOwner(owner);
    for (const entry of this.dynamicPool) entry.material = this.entryFor(entry.properties.materialGuid!, null);
    this.pruneEntries();
  }

  /** Releases every Material no decal draws with any more, and its draw slot. */
  private pruneEntries(): void {
    const used = new Set<DecalMaterialEntry>();
    for (const owner of this.owners.values()) for (const decal of owner.decals) if (decal.material) used.add(decal.material);
    for (const entry of this.dynamicPool) if (entry.material) used.add(entry.material);
    for (const [key, entry] of this.materialEntries) {
      if (used.has(entry)) continue;
      this.materialEntries.delete(key);
      this.dropSlot(entry.material);
      if (entry.instance) this.materialSource?.release?.(entry.instance.key, entry.guid);
    }
    for (const material of this.firstDraws) if (!this.slots.has(material)) this.firstDraws.delete(material);
  }

  private releaseEntries(): void {
    for (const entry of this.materialEntries.values()) {
      this.dropSlot(entry.material);
      if (entry.instance) this.materialSource?.release?.(entry.instance.key, entry.guid);
    }
    this.materialEntries.clear();
    for (const owner of this.owners.values()) for (const decal of owner.decals) decal.material = null;
    for (const entry of this.dynamicPool) entry.material = null;
  }

  /** Drops the oldest dynamic decals past `capacity`, so a quality downshift keeps the newest. */
  private fitDynamicCapacity(capacity: number): void {
    const excess = this.dynamicPool.length - capacity;
    if (excess <= 0) return;
    this.dynamicPool.splice(0, excess);
    this.dynamicReleased = true;
  }

  spawnDynamic(request: DynamicDecalSpawnRequest): void {
    const materialGuid = typeof request.materialGuid === "string" ? request.materialGuid.trim() : "";
    if (!materialGuid) return;
    const size: [number, number, number] = [
      request.size[0] > 0 ? request.size[0] : 1,
      request.size[1] > 0 ? request.size[1] : 1,
      request.size[2] > 0 ? request.size[2] : 1,
    ];
    const world = Matrix.Compose(
      new Vector3(size[0], size[1], size[2]),
      Quaternion.FromArray(request.rotation),
      Vector3.FromArray(request.position),
    );
    const determinant = world.determinant();
    if (Math.abs(determinant) <= 1e-8) return;
    const inverseWorld = world.clone().invert();
    const bounds = new BoundingInfo(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));
    bounds.update(world);
    const center = new Vector3(world.m[12]!, world.m[13]!, world.m[14]!);
    let farthest = 0;
    for (const corner of bounds.boundingBox.vectorsWorld) {
      farthest = Math.max(farthest, Vector3.DistanceSquared(corner, center));
    }
    const unit = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
    const properties: DecalProperties = {
      enabled: true,
      materialGuid,
      tint: request.tint ? [unit(request.tint[0], 1), unit(request.tint[1], 1), unit(request.tint[2], 1)] : [...DEFAULT_DECAL_PROPERTIES.tint],
      opacity: unit(request.opacity, 1),
      size,
      fadeAngle: typeof request.fadeAngle === "number" && Number.isFinite(request.fadeAngle) ? Math.min(180, Math.max(1, request.fadeAngle)) : DEFAULT_DECAL_PROPERTIES.fadeAngle,
      sortOrder: typeof request.sortOrder === "number" && Number.isFinite(request.sortOrder) ? Math.round(request.sortOrder) : 0,
      cullDistance: typeof request.cullDistance === "number" && Number.isFinite(request.cullDistance) ? Math.max(0, request.cullDistance) : 0,
    };
    const entry: DynamicDecalEntry = {
      world,
      inverseWorld,
      center,
      radius: Math.sqrt(farthest),
      mirrored: determinant < 0,
      properties,
      opacityMultiplier: 1,
      material: this.entryFor(materialGuid, null),
      age: 0,
      lifetime: typeof request.lifetime === "number" && Number.isFinite(request.lifetime) && request.lifetime > 0 ? request.lifetime : 0,
      fadeOutDuration: typeof request.fadeOutDuration === "number" && Number.isFinite(request.fadeOutDuration) && request.fadeOutDuration > 0 ? request.fadeOutDuration : 0,
    };
    // Expired decals have already left the pool, so a full pool evicts its oldest live decal, whatever its lifetime.
    this.fitDynamicCapacity(maxDynamicDecalsForScene(this.scene) - 1);
    this.dynamicPool.push(entry);
    this.pruneReleased();
    this.demandDynamic();
  }

  private demandDynamic(): void {
    if (this.dynamicDemand) return;
    this.dynamicDemand = true;
    this.demandRevision += 1;
  }

  private pruneReleased(): void {
    if (!this.dynamicReleased) return;
    this.dynamicReleased = false;
    this.pruneEntries();
  }

  /** Ages dynamic decals by `deltaSeconds` of game time; expired ones leave the pool. */
  advanceTimers(deltaSeconds: number): void {
    if (!(deltaSeconds > 0)) return;
    const pool = this.dynamicPool;
    let kept = 0;
    for (let index = 0; index < pool.length; index++) {
      const entry = pool[index]!;
      if (entry.lifetime > 0) {
        entry.age += deltaSeconds;
        if (entry.age >= entry.lifetime) continue;
        if (entry.fadeOutDuration > 0) {
          const remaining = entry.lifetime - entry.age;
          entry.opacityMultiplier = remaining < entry.fadeOutDuration ? Math.max(0, remaining / entry.fadeOutDuration) : 1;
        }
      }
      pool[kept++] = entry;
    }
    if (kept === pool.length) return;
    pool.length = kept;
    this.dynamicReleased = true;
  }

  /**
   * Ages dynamic decals once per Engine frame, however many views prepare in it (a Render Target Capture, a second
   * viewport), by the frame's time × the simulation time scale, and not at all while paused.
   */
  private advanceClock(): void {
    const engine = this.scene.getEngine();
    const frame = engine.frameId;
    if (frame === this.clockFrame) return;
    this.clockFrame = frame;
    if (this.paused || this.timeScale <= 0) return;
    this.advanceTimers((engine.getDeltaTime() / 1000) * this.timeScale);
  }

  /**
   * Cull decals against `camera` frustum + quality-scaled `cullDistance` and group them by sort order, Material and
   * winding into instanced batches. Returns `true` when the pass has something to draw this frame: a visible decal whose
   * Material resolved, or a warmed Material's first draw.
   */
  prepare(camera: Camera, force = false): boolean {
    const frameId = this.scene.getFrameId();
    if (!force && this.preparedFrameId === frameId && this.preparedCamera === camera) {
      return this.lastPreparedResult;
    }
    this.preparedFrameId = frameId;
    this.preparedCamera = camera;
    this.advanceClock();
    this.fitDynamicCapacity(maxDynamicDecalsForScene(this.scene));
    this.pruneReleased();

    this.batches.length = 0;
    this.batchMap.clear();
    this.lastVisibleCount = 0;

    camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), this.viewProjection);
    Frustum.GetPlanesToRef(this.viewProjection, this.planes);
    const camPos = camera.globalPosition ?? camera.position;
    const distanceScale = sceneRenderingSettings(this.scene).lodDistanceScale;

    const admit = (item: PreparedDecal) => {
      if (item.properties.opacity * item.opacityMultiplier <= 0.004) return;
      if (item.properties.cullDistance > 0) {
        const effectiveCull = item.properties.cullDistance * distanceScale;
        const dist = Math.max(0, Vector3.Distance(camPos, item.center) - item.radius);
        if (dist > effectiveCull) return;
      }
      if (sphereFrustumSide(this.planes, item.center, item.radius) < 0) return;
      const material = this.materialOf(item.material);
      if (!material) return;

      const key = `${item.properties.sortOrder}|${material.uniqueId}|${item.mirrored ? 1 : 0}`;
      let batch = this.batchMap.get(key);
      if (!batch) {
        batch = { key, sortOrder: item.properties.sortOrder, mirrored: item.mirrored, material, items: [] };
        this.batchMap.set(key, batch);
        this.batches.push(batch);
      }
      batch.items.push(item);
      this.lastVisibleCount += 1;
    };

    for (const owner of this.owners.values()) {
      if (!owner.prepare()) continue;
      for (const decal of owner.decals) {
        if (decal.valid) admit(decal);
      }
    }
    for (const entry of this.dynamicPool) admit(entry);

    this.batches.sort((a, b) => a.sortOrder - b.sortOrder);
    this.lastPreparedResult = this.batches.length > 0 || this.firstDraws.size > 0;
    return this.lastPreparedResult;
  }

  get currentBatches(): readonly DecalBatch[] {
    return this.batches;
  }

  stats(): SceneDecalStats {
    let authored = 0;
    for (const owner of this.owners.values()) authored += owner.decals.length;
    return {
      authored,
      dynamic: this.dynamicPool.length,
      visible: this.lastVisibleCount,
      batches: this.batches.length,
      draws: this.totalDraws,
      capacity: maxDynamicDecalsForScene(this.scene),
      pending: this.lastPending,
      materials: this.slots.size,
    };
  }

  /** Whether the last render skipped a decal whose Material's program was not ready (a capture waits for it). */
  hasPendingDecals(): boolean {
    return this.lastPending > 0;
  }

  /** The draw slot of `material`, with room for `count` decals. */
  private slotFor(material: NodeMaterial, count: number): DecalDrawSlot {
    let slot = this.slots.get(material);
    if (!slot) {
      const cube = CreateBox(`${DECAL_PROXY_PREFIX}:${material.name}`, { size: 1 }, this.scene);
      // Keep internal decal proxy out of scene.meshes so picking, culling, shadows and readiness ignore it.
      this.scene.removeMesh(cube);
      cube.isPickable = false;
      cube.doNotSyncBoundingInfo = true;
      // A decal receives the shadows the surface under it receives (the light block's receiver term).
      cube.receiveShadows = true;
      slot = {
        material, cube, capacity: 0, world: new Float32Array(0), awaited: null,
        rows: Object.fromEntries(DECAL_INSTANCE_ATTRIBUTES.map((name) => [name, new Float32Array(0)])) as DecalDrawSlot["rows"],
      };
      this.slots.set(material, slot);
    }
    if (slot.capacity < count || slot.capacity === 0) {
      let capacity = Math.max(16, slot.capacity);
      while (capacity < count) capacity *= 2;
      slot.capacity = capacity;
      slot.world = new Float32Array(capacity * 16);
      slot.cube.thinInstanceSetBuffer("matrix", slot.world, 16, false);
      for (const name of DECAL_INSTANCE_ATTRIBUTES) {
        slot.rows[name] = new Float32Array(capacity * 4);
        slot.cube.thinInstanceSetBuffer(name, slot.rows[name], 4, false);
      }
    }
    return slot;
  }

  private dropSlot(material: NodeMaterial | null): void {
    if (!material) return;
    const slot = this.slots.get(material);
    if (!slot) return;
    this.slots.delete(material);
    this.firstDraws.delete(material);
    slot.cube.dispose();
  }

  /**
   * Whether `material`'s program is ready on its slot. Never binds or draws one that is not: the decal is skipped, and a
   * compiling Effect asks for a redraw when it finishes (an Effect not created yet asks every frame until it is).
   */
  private slotReady(slot: DecalDrawSlot): boolean {
    const subMesh = slot.cube.subMeshes[0];
    if (!subMesh) return false;
    if (slot.material.isReadyForSubMesh(slot.cube, subMesh, true) && subMesh.effect?.isReady()) return true;
    const effect = subMesh.effect;
    if (effect && effect.getCompilationError()) return false;
    if (effect && slot.awaited !== effect) {
      slot.awaited = effect;
      effect.executeWhenCompiled(() => this.onPending?.());
    } else if (!effect) {
      this.onPending?.();
    }
    return false;
  }

  /**
   * Compile `materials` on their own draw slots, as the pass draws them, so a decal's first frame does not wait for its
   * link, and draw each once in the next pass (degenerate, covering no pixel) for drivers that link at a program's first
   * draw. Also keeps the decal pass in the forward graph, as a Spawn Decal does. Ends at once for a Material that is
   * not a Decal Material, and gives up on one that does not compile within the warm-up bound.
   */
  async warm(materials: Iterable<Material>, assertCurrent?: () => void): Promise<number> {
    const slots: DecalDrawSlot[] = [];
    for (const material of materials) {
      if (!(material instanceof NodeMaterial) || (material.metadata as { materialDomain?: unknown } | null)?.materialDomain !== "decal") continue;
      slots.push(this.slotFor(material, 1));
    }
    if (!slots.length) return 0;
    this.demandDynamic();
    const bound = createHeldThreadBound(SCENE_SHADER_WARM_TIMEOUT_MS, undefined, renewOnCompileProgress(this.scene.getEngine()));
    let waiting = slots;
    while (waiting.length) {
      assertCurrent?.();
      waiting = waiting.filter((slot) => {
        if (this.slots.get(slot.material) !== slot || isDisposedNodeMaterial(slot.material, this.scene)) return false;
        const subMesh = slot.cube.subMeshes[0];
        if (!subMesh || subMesh.effect?.getCompilationError()) return false;
        if (slot.material.isReadyForSubMesh(slot.cube, subMesh, true) && subMesh.effect?.isReady()) {
          this.firstDraws.add(slot.material);
          return false;
        }
        return true;
      });
      if (!waiting.length || bound.expired()) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    return slots.length - waiting.length;
  }

  /** Fills `slot`'s instance rows for `items` (or one degenerate row when there are none) and returns the count. */
  private writeRows(slot: DecalDrawSlot, items: readonly PreparedDecal[], relative: boolean, eye: Vector3): number {
    const count = Math.max(1, items.length);
    const rows = slot.rows;
    if (!items.length) {
      // A first draw: a zero world collapses every vertex to one point, so it rasterizes nothing.
      slot.world.fill(0, 0, 16);
      for (const name of DECAL_INSTANCE_ATTRIBUTES) rows[name].fill(0, 0, 4);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const inv = item.inverseWorld.m;
      const o4 = i * 4;
      for (let c = 0; c < 4; c++) {
        rows.decalInv0[o4 + c] = inv[c]!;
        rows.decalInv1[o4 + c] = inv[4 + c]!;
        rows.decalInv2[o4 + c] = inv[8 + c]!;
      }
      if (relative) {
        writeRelativeWorld(item.world, eye, slot.world, i * 16);
        // The inverse of the relative world: an eye-relative point is first moved back by the eye (in 64 bits).
        for (let c = 0; c < 4; c++) rows.decalInv3[o4 + c] = eye.x * inv[c]! + eye.y * inv[4 + c]! + eye.z * inv[8 + c]! + inv[12 + c]!;
      } else {
        item.world.copyToArray(slot.world, i * 16);
        for (let c = 0; c < 4; c++) rows.decalInv3[o4 + c] = inv[12 + c]!;
      }
      rows.decalTintOpacity[o4] = item.properties.tint[0];
      rows.decalTintOpacity[o4 + 1] = item.properties.tint[1];
      rows.decalTintOpacity[o4 + 2] = item.properties.tint[2];
      rows.decalTintOpacity[o4 + 3] = item.properties.opacity * item.opacityMultiplier;
      rows.decalParams[o4] = 0;
      rows.decalParams[o4 + 1] = Math.cos((item.properties.fadeAngle * Math.PI) / 180);
      rows.decalParams[o4 + 2] = 0;
      rows.decalParams[o4 + 3] = 0;
    }
    const cube = slot.cube;
    cube.thinInstanceCount = count;
    cube.thinInstancePartialBufferUpdate("matrix", slot.world.subarray(0, count * 16), 0);
    for (const name of DECAL_INSTANCE_ATTRIBUTES) cube.thinInstancePartialBufferUpdate(name, rows[name].subarray(0, count * 4), 0);
    return count;
  }

  /** Draw all prepared decal batches against the resolved opaque depth buffer. */
  render(
    context: FrameGraphRenderContext,
    camera: Camera,
    depthHandle: FrameGraphTextureHandle,
    width: number,
    height: number,
  ): number {
    this.lastPending = 0;
    if (this.batches.length === 0 && this.firstDraws.size === 0) return 0;
    const engine = this.scene.getEngine();

    context.setTextureSamplingMode(depthHandle, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    // Large World Rendering: positions are relative to the floating origin's eye, as every other draw's and the
    // HapticLights, clusters and shadow views are. The view takes the eye's translation first (in 64 bits), the
    // instance rows lose it, and the depth reconstruction, OBB test, lighting and fog all work in that one space.
    // Without it, every value is the camera's own, unchanged.
    const relative = this.scene.floatingOriginMode;
    const eye = this.scene.floatingOriginOffset;
    let view = camera.getViewMatrix();
    if (relative) {
      Matrix.TranslationToRef(eye.x, eye.y, eye.z, this.eyeTranslation);
      this.eyeTranslation.multiplyToRef(view, this.relativeView);
      view = this.relativeView;
    }
    view.multiplyToRef(camera.getProjectionMatrix(), this.viewProjection);
    if (Math.abs(this.viewProjection.determinant()) <= 1e-12) return 0;
    this.viewProjection.invertToRef(this.invViewProjection);
    const camPos = camera.globalPosition ?? camera.position;
    if (relative) this.cameraRelative.copyFromFloats(camPos.x - eye.x, camPos.y - eye.y, camPos.z - eye.z);
    else this.cameraRelative.copyFrom(camPos);

    let drawnBatches = 0;
    const draw = (slot: DecalDrawSlot, items: readonly PreparedDecal[], mirrored: boolean): boolean => {
      const subMesh = slot.cube.subMeshes[0];
      if (!subMesh || !this.slotReady(slot)) return false;
      const drawWrapper = subMesh._drawWrapper;
      const effect = drawWrapper.effect!;
      const count = this.writeRows(slot, items, relative, eye);
      engine.enableEffect(drawWrapper);
      // Front-face culling draws the OBB's far faces, so entering a decal volume never near-clips it. A mirrored
      // world (negative determinant) flips the cube's winding, so its batch culls the other side.
      engine.setState(true, 0, false, mirrored, false);
      slot.cube._bind(subMesh, effect, Material.TriangleFillMode);
      // Every batch binds in full: a frozen Material skips its bindings when the previous draw used the same Effect.
      this.scene.resetCachedMaterial();
      slot.material.bindForSubMesh(IDENTITY, slot.cube, subMesh);
      effect.setMatrix(DECAL_PASS_UNIFORMS.viewProjection, this.viewProjection);
      effect.setMatrix(DECAL_PASS_UNIFORMS.invViewProjection, this.invViewProjection);
      effect.setMatrix(DECAL_PASS_UNIFORMS.view, view);
      effect.setFloat2(DECAL_PASS_UNIFORMS.invViewport, 1 / Math.max(1, width), 1 / Math.max(1, height));
      effect.setFloat2(DECAL_PASS_UNIFORMS.depthRange, 2, -1);
      effect.setFloat(DECAL_PASS_UNIFORMS.reverseDepth, engine.useReverseDepthBuffer ? 1 : 0);
      effect.setVector3(DECAL_PASS_UNIFORMS.cameraPosition, this.cameraRelative);
      context.bindTextureHandle(effect, DECAL_SCENE_DEPTH_SAMPLER, depthHandle);
      engine.setAlphaMode(slot.material.alphaMode);
      engine.drawElementsType(Material.TriangleFillMode, subMesh.indexStart, subMesh.indexCount, count);
      return true;
    };

    engine.setDepthBuffer(false);
    engine.setDepthWrite(false);
    try {
      for (const batch of this.batches) {
        const slot = this.slotFor(batch.material, batch.items.length);
        if (!draw(slot, batch.items, batch.mirrored)) {
          this.lastPending += 1;
          continue;
        }
        this.firstDraws.delete(batch.material);
        drawnBatches += 1;
        this.totalDraws += 1;
      }
      for (const material of [...this.firstDraws]) {
        const slot = this.slots.get(material);
        if (!slot || isDisposedNodeMaterial(material, this.scene)) { this.firstDraws.delete(material); continue; }
        if (draw(slot, [], false)) this.firstDraws.delete(material);
      }
    } finally {
      engine.setAlphaMode(Constants.ALPHA_DISABLE);
      engine.setDepthWrite(true);
      engine.setDepthBuffer(true);
      engine.setState(true, 0, false, true, false);
    }
    return drawnBatches;
  }

  dispose(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
    this.dynamicPool.length = 0;
    this.batches.length = 0;
    this.releaseEntries();
    for (const slot of this.slots.values()) slot.cube.dispose();
    this.slots.clear();
    this.firstDraws.clear();
  }
}

const hosts = new WeakMap<Scene, SceneDecalHost>();

export function sceneDecalHost(scene: Scene): SceneDecalHost {
  let host = hosts.get(scene);
  if (!host) {
    host = new SceneDecalHost(scene);
    hosts.set(scene, host);
  }
  return host;
}

export function sceneHasDecals(scene: Scene): boolean {
  return hosts.get(scene)?.hasAnyDecals() ?? false;
}

export function sceneDecalStats(scene: Scene): SceneDecalStats {
  return sceneDecalHost(scene).stats();
}

/** Whether `scene`'s last decal pass skipped a decal whose Material was not ready yet. */
export function sceneDecalsPending(scene: Scene): boolean {
  return hosts.get(scene)?.hasPendingDecals() ?? false;
}

export function setDecalMaterialSource(scene: Scene, source: DecalMaterialSource | null): void {
  sceneDecalHost(scene).setMaterialSource(source);
}

/** Asks for a redraw whenever the decal pass skipped a decal whose Material was still compiling. */
export function setDecalPendingListener(scene: Scene, listener: (() => void) | null): void {
  sceneDecalHost(scene).setPendingListener(listener);
}

/** A Material document changed or a generation was published: the decals ask their source again. */
export function refreshDecalMaterials(scene: Scene): void {
  hosts.get(scene)?.refreshMaterials();
}

/** Compile Decal Materials before their first decal draws (`SceneDecalHost.warm`). Returns how many became ready. */
export function warmDecalMaterials(scene: Scene, materials: Iterable<Material>, assertCurrent?: () => void): Promise<number> {
  return sceneDecalHost(scene).warm(materials, assertCurrent);
}

export function upsertDecals(scene: Scene, actorId: string, node: TransformNode, bindings: readonly DecalBinding[], admitted = true): void {
  if (!bindings.length && !hosts.has(scene)) return;
  sceneDecalHost(scene).upsertActor(actorId, node, bindings, admitted);
}

export function setDecalsVisible(scene: Scene, actorId: string, visible: boolean): void {
  hosts.get(scene)?.setActorVisible(actorId, visible);
}

export function removeDecals(scene: Scene, actorId: string): void {
  hosts.get(scene)?.removeActor(actorId);
}

export function clearDecals(scene: Scene): void {
  hosts.get(scene)?.clear();
}

export function spawnDynamicDecal(scene: Scene, request: DynamicDecalSpawnRequest): void {
  sceneDecalHost(scene).spawnDynamic(request);
}

/** Holds or resumes dynamic decal lifetimes with the game's pause (Play's `applyPause`, as for particles). */
export function setDecalTimePaused(scene: Scene, paused: boolean): void {
  sceneDecalHost(scene).setPaused(paused);
}

/** Scales dynamic decal lifetimes by the simulation time scale (`setSimulationTimeScale`, as for particles). */
export function setDecalTimeScale(scene: Scene, scale: number): void {
  sceneDecalHost(scene).setTimeScale(scale);
}

/** FrameGraph render pass that projects all visible instanced decals onto opaque scene geometry. */
export class FrameGraphDecalTask extends FrameGraphTask {
  camera!: Camera;
  targetTexture!: FrameGraphTextureHandle;
  depthTexture!: FrameGraphTextureHandle;
  draws = 0;

  constructor(name: string, graph: FrameGraph) {
    super(name, graph);
  }

  override getClassName(): string {
    return "FrameGraphDecalTask";
  }

  override isReady(): boolean {
    return true;
  }

  override record(): void {
    const graph = this._frameGraph;
    const size = graph.textureManager.getTextureAbsoluteDimensions(this.targetTexture);
    const pass = graph.addRenderPass(this.name);
    pass.setRenderTarget(this.targetTexture);
    pass.addDependencies([this.depthTexture]);
    pass.setExecuteFunc((context) => {
      const host = hosts.get(graph.scene);
      if (!host) return;
      this.draws += host.render(context, this.camera, this.depthTexture, size.width, size.height);
    });
    const disabled = graph.addRenderPass(`${this.name}_disabled`, true);
    disabled.setRenderTarget(this.targetTexture);
    disabled.setExecuteFunc(() => {});
  }
}

function blendsForMesh(mesh: AbstractMesh, scene: Scene): boolean {
  if (mesh.visibility < 1 || mesh.hasVertexAlpha) return true;
  const material = mesh.material ?? scene.defaultMaterial;
  if (!material) return false;
  if (material instanceof MultiMaterial) {
    const subMaterials = material.subMaterials;
    for (let index = 0; index < subMaterials.length; index += 1) {
      if (subMaterials[index]?.needAlphaBlendingForMesh(mesh)) return true;
    }
    return false;
  }
  return material.needAlphaBlendingForMesh(mesh);
}

function listed(list: readonly AbstractMesh[], count: number, mesh: AbstractMesh): boolean {
  for (let index = 0; index < count; index += 1) if (list[index] === mesh) return true;
  return false;
}

class DecalSplitTask extends FrameGraphTask {
  private readonly onSplit: () => void;
  constructor(name: string, graph: FrameGraph, onSplit: () => void) {
    super(name, graph);
    this.onSplit = onSplit;
  }
  override getClassName(): string {
    return "DecalSplitTask";
  }
  override record(): void {
    this._frameGraph.addPass(this.name).setExecuteFunc(this.onSplit);
  }
}

export interface DecalSplitGraphOptions {
  frameGraph: FrameGraph;
  camera: Camera;
  cull: FrameGraphCullObjectsTask;
  objects: ManagedShadowObjectRendererTask;
  targetColor: FrameGraphTextureHandle;
  targetDepth: FrameGraphTextureHandle;
}

/**
 * Lightweight opaque/transparent split used when decals exist without water scene copy:
 *
 *   Forward cull → Decal split → Forward objects (opaque) → Forward decals → Forward transparent
 *
 * On frames where zero decals enter the camera frustum, both `Forward decals` and
 * `Forward transparent` stay disabled and `Forward objects` draws everything in one pass.
 */
export class DecalSplitGraph {
  readonly split: FrameGraphTask;
  readonly decalTask: FrameGraphDecalTask;
  readonly transparent: ManagedShadowObjectRendererTask;
  readonly afterObjects: FrameGraphTask[];
  readonly shadowReceivers: ManagedShadowObjectRendererTask[];
  private readonly scene: Scene;
  private readonly cull: FrameGraphCullObjectsTask;
  private readonly objects: ManagedShadowObjectRendererTask;
  private readonly transparentMeshes: AbstractMesh[] = [];
  private readonly noParticles: IParticleSystem[] = [];
  private readonly transparentList: FrameGraphObjectList;
  private readonly probeMeshes: AbstractMesh[] = [];
  private readonly probeList: FrameGraphObjectList = { meshes: null, particleSystems: null };
  private probing: FrameGraphObjectList | undefined;
  private camera: Camera;
  private visible: boolean | undefined;

  constructor(options: DecalSplitGraphOptions) {
    const { frameGraph: graph, camera } = options;
    this.scene = graph.scene;
    this.camera = camera;
    this.cull = options.cull;
    this.objects = options.objects;
    this.transparentList = { meshes: this.transparentMeshes, particleSystems: this.noParticles };

    this.decalTask = new FrameGraphDecalTask("Forward decals", graph);
    this.decalTask.camera = camera;
    this.decalTask.targetTexture = options.targetColor;
    this.decalTask.depthTexture = options.targetDepth;

    const transparent = new ManagedShadowObjectRendererTask("Forward transparent", graph, this.scene, { doNotChangeAspectRatio: false });
    this.transparent = transparent;
    transparent.mainView = true;
    transparent.camera = camera;
    transparent.targetTexture = options.targetColor;
    transparent.depthTexture = options.targetDepth;
    transparent.renderDepthOnlyMeshes = false;
    transparent.renderOpaqueMeshes = false;
    transparent.renderAlphaTestMeshes = false;
    transparent.enableBoundingBoxRendering = false;
    for (let group = RenderingManager.MIN_RENDERINGGROUPS; group < RenderingManager.MAX_RENDERINGGROUPS; group += 1) {
      transparent.objectRenderer.setRenderingAutoClearDepthStencil(group, false);
    }
    transparent.objectList = this.transparentList;

    this.split = new DecalSplitTask("Decal split", graph, () => this.splitFrame());
    this.afterObjects = [this.decalTask, transparent];
    this.shadowReceivers = [transparent];
    this.apply(false);
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.decalTask.camera = camera;
    this.transparent.camera = camera;
  }

  beginProbe(all: FrameGraphObjectList): void {
    if (this.probing) return;
    this.probing = this.transparent.objectList;
    const meshes = all.meshes ?? this.scene.meshes;
    const probe = this.probeMeshes;
    let count = 0;
    for (let index = 0; index < meshes.length; index += 1) {
      const mesh = meshes[index]!;
      if (blendsForMesh(mesh, this.scene)) probe[count++] = mesh;
    }
    probe.length = count;
    this.probeList.meshes = probe;
    this.probeList.particleSystems = all.particleSystems ?? this.noParticles;
    this.transparent.objectList = this.probeList;
  }

  endProbe(): void {
    const saved = this.probing;
    if (!saved) return;
    this.probing = undefined;
    this.transparent.objectList = saved;
    this.probeMeshes.length = 0;
    this.probeList.meshes = null;
  }

  private splitFrame(): void {
    const host = hosts.get(this.scene);
    const visible = host ? host.prepare(this.camera) : false;
    const list = this.transparentMeshes;
    if (visible) {
      const culled = this.cull.outputObjectList;
      const meshes = culled.meshes ?? this.scene.meshes;
      let count = 0;
      for (let index = 0; index < meshes.length; index += 1) {
        const mesh = meshes[index]!;
        if (blendsForMesh(mesh, this.scene)) list[count++] = mesh;
      }
      const systems = culled.particleSystems ?? this.scene.particleSystems;
      for (let index = 0; index < systems.length; index += 1) {
        const system = systems[index]!;
        const emitter = system.emitter;
        if (!emitter || !("position" in emitter) || !system.isStarted()) continue;
        if (listed(list, count, emitter) || meshes.indexOf(emitter) === -1) continue;
        list[count++] = emitter;
      }
      list.length = count;
      this.transparentList.particleSystems = systems;
    } else if (list.length) {
      list.length = 0;
    }
    this.apply(visible);
  }

  private apply(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.decalTask.disabled = !visible;
    this.transparent.disabled = !visible;
    this.objects.renderTransparentMeshes = !visible;
    this.objects.renderParticles = !visible;
    this.objects.renderSprites = !visible;
  }

  dispose(): void {
    this.split.dispose();
    this.decalTask.dispose();
    this.transparent.dispose();
  }
}
