import type { CommandMessage } from "@babylonslate/bridge";
import {
  normalizeWaterDefinition,
  type CollisionTriangleMesh,
  type SceneLayerSettings,
  type SerializedActor,
  type SerializedScene,
  type WaterDefinition,
} from "@babylonslate/core";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import type { Actor, World } from "@babylonslate/object-model";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  loadRapier2DBackendFactory,
  SoftwarePhysicsBackend,
  type PhysicsBackend,
  type PhysicsWorldKind,
  type Vec3,
} from "@babylonslate/physics";
import type { RuntimeDiagnostic } from "./diagnostics";
import { componentIdFromColliderPhysicsId } from "./physics-collider-id";
import { PhysicsWorldSync } from "./physics-sync";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { sceneRealizationCancelled } from "./scene-realization-work";
import type { ScriptHost } from "./script-host";

type Vec3Tuple = [number, number, number];

interface RuntimePhysicsWorldsHost {
  world(): World;
  stopped(): boolean;
  /** Advances on Stop; a native load begun earlier is discarded. */
  lifecycleId(): number;
  /** Main-Scene physics simulates root actors whose streamed Scene, if any, is ready. */
  mainActorReady(actor: Actor): boolean;
  /** Scene Layer physics simulates layer actors their layer admits early. */
  overlayActorReady(actor: Actor): boolean;
  /** Some loaded Scene Layer document enables physics; otherwise no layer world can exist. */
  hasPhysicsSceneLayers(): boolean;
  canTickActor(actor: Actor): boolean;
  scripts(): Pick<ScriptHost, "invokeEvent">;
  frameId(): number;
  recordDiagnostic(diagnostic: RuntimeDiagnostic): void;
  emit(command: CommandMessage): void;
}

interface RuntimePhysicsWorldsOptions {
  kind: PhysicsWorldKind;
  gravity: Vec3Tuple;
  havokWasmUrl: string | undefined;
  preferSoftware: boolean;
  pixelsPerUnit?: number;
  tilemaps: Map<string, TilemapPayload>;
  tilesets: Map<string, TilesetPayload>;
}

const vec3 = (value: readonly number[]) => ({ x: value[0], y: value[1], z: value[2] });
const NO_GRAVITY: Vec3Tuple = [0, 0, 0];
/** Explicit physics components that need their layer's Enable Physics. */
const LAYER_PHYSICS_COMPONENTS = new Set(["RigidBodyComponent", "ColliderComponent", "BlockingVolumeComponent"]);

/** A physics-enabled Scene Layer instance: its gravity, and its world once first needed. */
interface LayerPhysicsWorld {
  readonly gravity: Vec3Tuple;
  sync: PhysicsWorldSync | null;
}

/**
 * The session's physics worlds: the main Scene world (3D or 2D, replaced when
 * the native backend loads or a Scene changes its world kind) and one 2D world
 * per Scene Layer instance that enables physics, with that layer's gravity.
 * A layer world is created on first need, steps natively only while it holds
 * bodies and is disposed with its layer; a layer without Enable Physics has
 * none. Owns backend selection and swaps, gravity, the tile/sprite/model/water
 * content the worlds collide with, complex-collision mesh requests, contact
 * dispatch to scripts and the collision debug view. The driver keeps the
 * step's place in the tick and reads `main` lazily, since it is replaced.
 */
export class RuntimePhysicsWorlds implements RuntimeSubsystem {
  private mainSync: PhysicsWorldSync;
  /** Physics-enabled layer instances in creation order (the step and dispatch order). */
  private readonly layerWorlds = new Map<string, LayerPhysicsWorld>();
  /** Native 2D worlds for layers, once `load` initialized Rapier. */
  private nativeLayerBackend: ((gravity: Vec3) => PhysicsBackend) | null = null;
  /** Layer assets already warned for physics components without Enable Physics. */
  private readonly warnedLayerAssets = new Set<string>();
  private worldKind: PhysicsWorldKind;
  private generation = 0;
  private currentGravity: Vec3Tuple;
  private readonly havokWasmUrl: string | undefined;
  private readonly preferSoftwarePhysics: boolean;
  private showCollision = false;
  private waters = new Map<string, WaterDefinition>();
  private tilemaps: Map<string, TilemapPayload>;
  private tilesets: Map<string, TilesetPayload>;
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private models = new Map<string, ModelPayload>();
  private _pixelsPerUnit = 100;
  /** Installed union: on-demand answers overlaid by the latest `loadModels` meshes. */
  private complexMeshes = new Map<string, CollisionTriangleMesh>();
  private lastProvidedComplexMeshes: ReadonlyMap<string, CollisionTriangleMesh> = new Map();
  private demandComplexMeshes = new Map<string, CollisionTriangleMesh>();
  private pendingComplexMeshes = new Set<string>();
  private unavailableComplexMeshes = new Set<string>();
  private warnedComplexMeshes = new Set<string>();
  /** Physics found a Complex Collision Model without a mesh: ask the host once to cook it. */
  private readonly missingComplexMesh = (assetGuid: string): void => {
    if (this.complexMeshes.has(assetGuid) || this.pendingComplexMeshes.has(assetGuid) ||
      this.unavailableComplexMeshes.has(assetGuid)) return;
    this.pendingComplexMeshes.add(assetGuid);
    this.host.emit({ type: "requestComplexCollision", assetGuid });
  };
  private readonly host: RuntimePhysicsWorldsHost;

  constructor(host: RuntimePhysicsWorldsHost, options: RuntimePhysicsWorldsOptions) {
    this.host = host;
    this.worldKind = options.kind;
    this.currentGravity = options.gravity;
    this.havokWasmUrl = options.havokWasmUrl;
    this.preferSoftwarePhysics = options.preferSoftware;
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) this._pixelsPerUnit = options.pixelsPerUnit;
    this.tilemaps = options.tilemaps;
    this.tilesets = options.tilesets;
    this.mainSync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend(this.worldKind, vec3(this.currentGravity)),
      {
        actorFilter: (actor) => actor.sceneLayerId == null && this.host.mainActorReady(actor),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics,
      },
    );
    this.mainSync.setMissingComplexMeshHandler(this.missingComplexMesh);
  }

  /** Main-Scene physics; replaced by `load`, `installScene` and `prepareScene`. */
  get main(): PhysicsWorldSync { return this.mainSync; }
  /** The main Scene's world kind. */
  get kind(): PhysicsWorldKind { return this.worldKind; }
  /** The main Scene's gravity (replaced, never mutated). */
  get gravity(): Vec3Tuple { return this.currentGravity; }
  get preferSoftware(): boolean { return this.preferSoftwarePhysics; }
  get pixelsPerUnit(): number { return this._pixelsPerUnit; }

  /**
   * The world that simulates this actor: its Scene Layer's own world, or null
   * when that layer did not enable physics. Other actors use the main world.
   */
  forActor(actor: Actor): PhysicsWorldSync | null {
    return actor.sceneLayerId ? this.layer(actor.sceneLayerId) : this.mainSync;
  }

  /** A Scene Layer instance's world, created on first need; null without Enable Physics. */
  layer(layerGuid: string): PhysicsWorldSync | null {
    const entry = this.layerWorlds.get(layerGuid);
    if (!entry) return null;
    return entry.sync ??= this.createLayerSync(layerGuid, entry.gravity);
  }

  /** Current gravity of the world that simulates this actor; Movement reads it each step. */
  gravityFor(actor: Actor): Vec3Tuple {
    if (!actor.sceneLayerId) return this.currentGravity;
    return this.layerWorlds.get(actor.sceneLayerId)?.gravity ?? NO_GRAVITY;
  }

  /**
   * A Scene Layer instance was created. With Enable Physics it gets its own
   * world with its gravity (created on first need); without, it gets none and
   * physics components in its actors are reported once per asset.
   */
  addLayer(
    layerGuid: string,
    assetGuid: string,
    settings: Pick<SceneLayerSettings, "gravity" | "physicsEnabled">,
    actors: readonly SerializedActor[],
  ): void {
    if (settings.physicsEnabled) {
      this.layerWorlds.set(layerGuid, { gravity: [settings.gravity[0], settings.gravity[1], settings.gravity[2]], sync: null });
      return;
    }
    if (this.warnedLayerAssets.has(assetGuid) ||
      !actors.some((actor) => actor.components?.some((component) => LAYER_PHYSICS_COMPONENTS.has(component.classId)))) return;
    this.warnedLayerAssets.add(assetGuid);
    const frameId = this.host.frameId();
    const diag: RuntimeDiagnostic = {
      code: "physics.scene_layer_physics_disabled",
      message: `Scene Layer ${assetGuid} has Rigid Body, Collider or Blocking Volume components, but Enable Physics is off. Its actors do not simulate or collide and fire no Hit or Overlap events; turn on Enable Physics in the Scene Layer's Details.`,
      severity: "warning",
      assetGuid,
      frameId,
      tickIndex: this.host.world().clock.tickIndex,
    };
    this.host.recordDiagnostic(diag);
    this.host.emit({ type: "diagnostic", code: diag.code, message: diag.message, assetGuid, frameId, severity: "warning" });
  }

  /** A Scene Layer instance left the session: release its world. */
  removeLayer(layerGuid: string): void {
    this.layerWorlds.get(layerGuid)?.sync?.dispose();
    this.layerWorlds.delete(layerGuid);
  }

  /** Stop, phase 2: release every world. */
  dispose(): void {
    this.mainSync.dispose();
    for (const entry of this.layerWorlds.values()) entry.sync?.dispose();
    this.layerWorlds.clear();
  }

  /** Upgrade both software worlds to Havok/Rapier and re-sync spawned bodies. */
  async load(): Promise<void> {
    if (this.host.stopped()) throw sceneRealizationCancelled();
    const lifecycleId = this.host.lifecycleId();
    const generation = this.generation;
    const current = () => !this.host.stopped() && lifecycleId === this.host.lifecycleId() && generation === this.generation;
    if (this.preferSoftwarePhysics) return;
    if (!(this.mainSync.getBackend() instanceof SoftwarePhysicsBackend)) {
      return;
    }
    const backend = await createPhysicsBackend({
      kind: this.worldKind,
      gravity: vec3(this.currentGravity),
      havokWasmUrl: this.havokWasmUrl,
      allowSoftwareFallback: false,
    });
    if (!current()) {
      backend.dispose();
      throw sceneRealizationCancelled();
    }
    let layerBackend: ((gravity: Vec3) => PhysicsBackend) | null = null;
    try {
      // Only physics-enabled layers need Rapier; other sessions never load it for layers.
      if (this.layerWorlds.size > 0 || this.host.hasPhysicsSceneLayers()) layerBackend = await loadRapier2DBackendFactory();
    } catch (error) {
      backend.dispose();
      throw error;
    }

    if (!current()) {
      backend.dispose();
      throw sceneRealizationCancelled();
    }
    backend.setGravity(vec3(this.currentGravity));
    const world = this.host.world();
    const physicsSync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId == null && this.host.mainActorReady(actor),
    });
    this.nativeLayerBackend = layerBackend;
    // Layer worlds already created move to native worlds with their own gravity.
    const layerSyncs: Array<[LayerPhysicsWorld, PhysicsWorldSync]> = [];
    try {
      this.bindContent(physicsSync);
      physicsSync.syncFromWorld(world);
      for (const [layerGuid, entry] of this.layerWorlds) {
        if (!entry.sync) continue;
        const sync = this.createLayerSync(layerGuid, entry.gravity);
        layerSyncs.push([entry, sync]);
        sync.syncFromWorld(world);
      }
    } catch (error) {
      this.nativeLayerBackend = null;
      physicsSync.dispose();
      for (const [, sync] of layerSyncs) sync.dispose();
      throw error;
    }
    this.mainSync.dispose();
    this.mainSync = physicsSync;
    for (const [entry, sync] of layerSyncs) {
      entry.sync?.dispose();
      entry.sync = sync;
    }
  }

  /** A Scene of this kind must replace the loaded native main world. */
  replacesNative(kind: PhysicsWorldKind): boolean {
    return kind !== this.worldKind && !(this.mainSync.getBackend() instanceof SoftwarePhysicsBackend);
  }

  /** Native backend for a Scene's main world; `installScene` adopts it. */
  acquireNative(kind: PhysicsWorldKind, gravity: readonly number[]): Promise<PhysicsBackend> {
    return createPhysicsBackend({ kind, gravity: vec3(gravity), havokWasmUrl: this.havokWasmUrl, allowSoftwareFallback: false });
  }

  /**
   * Replace the main world with one on `backend`, bound to the current content
   * and synced from the World. `check` throws when the Scene load is no longer
   * current; the new world (or backend) is then released.
   */
  installScene(backend: PhysicsBackend, check: () => void): void {
    let sync: PhysicsWorldSync | undefined;
    try {
      check();
      sync = new PhysicsWorldSync(backend, {
        actorFilter: (actor) => actor.sceneLayerId == null && this.host.mainActorReady(actor),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics && backend instanceof SoftwarePhysicsBackend,
      });
      this.bindContent(sync);
      sync.syncFromWorld(this.host.world());
    } catch (error) {
      if (sync) sync.dispose(); else backend.dispose();
      throw error;
    }
    this.mainSync.dispose();
    this.mainSync = sync;
    this.worldKind = backend.kind;
    this.generation++;
  }

  /** A Scene of another world kind gets a software main world (a native one was installed earlier). */
  prepareScene(settings: SerializedScene["settings"] | undefined, check: () => void): void {
    const kind = settings?.physicsWorld ?? this.worldKind;
    if (kind !== this.worldKind) {
      const gravity = settings?.gravity ?? this.currentGravity;
      this.installScene(createSoftwarePhysicsBackend(kind, vec3(gravity)), check);
    }
  }

  /** Main-Scene gravity; non-finite components become 0. Returns the stored value. */
  setGravity(gravity: { x: number; y: number; z: number }): Vec3Tuple {
    const next: Vec3Tuple = [
      Number.isFinite(gravity.x) ? gravity.x : 0,
      Number.isFinite(gravity.y) ? gravity.y : 0,
      Number.isFinite(gravity.z) ? gravity.z : 0,
    ];
    this.currentGravity = next;
    this.mainSync.getBackend().setGravity(vec3(next));
    return next;
  }

  /** Main-Scene step; movement motors run inside it. Water bodies then publish the water clock. */
  stepMain(dt: number, tickIndex: number, beforeStep: (sync: PhysicsWorldSync) => unknown): void {
    const time = tickIndex * dt;
    this.mainSync.step(dt, this.host.world(), time, -this.currentGravity[1], () => beforeStep(this.mainSync));
    if (this.mainSync.water.hasBodies) this.host.emit({ type: "waterTime", seconds: time });
  }

  /** Each Scene Layer world in creation order; a world without bodies skips its native step. */
  stepLayers(dt: number, beforeStep: (sync: PhysicsWorldSync) => unknown): void {
    if (this.layerWorlds.size === 0) return;
    const world = this.host.world();
    for (const layerGuid of this.layerWorlds.keys()) {
      const sync = this.layer(layerGuid);
      sync?.step(dt, world, undefined, undefined, () => beforeStep(sync));
    }
  }

  /** Reconcile every Scene Layer world's bodies with the World. */
  syncLayers(): void {
    const world = this.host.world();
    for (const layerGuid of this.layerWorlds.keys()) this.layer(layerGuid)?.syncFromWorld(world);
  }

  /** Bind the current content to every world. */
  bindAll(): void {
    this.bindContent(this.mainSync);
    for (const sync of this.layerSyncs()) this.bindContent(sync);
  }

  registerWaterContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    this.waters = new Map(Array.from(content instanceof Map ? content.entries() : Object.entries(content), ([guid, value]) => [guid, normalizeWaterDefinition(value)]));
    this.mainSync.water.setContent(this.waters);
  }

  registerTileContent(tilemaps: Map<string, TilemapPayload>, tilesets: Map<string, TilesetPayload>, pixelsPerUnit?: number): void {
    this.tilemaps = tilemaps;
    this.tilesets = tilesets;
    if (pixelsPerUnit && pixelsPerUnit > 0) {
      this._pixelsPerUnit = pixelsPerUnit;
    }
    this.mainSync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this._pixelsPerUnit,
    });
    for (const sync of this.layerSyncs()) {
      sync.setTileContent({
        tilemaps: this.tilemaps,
        tilesets: this.tilesets,
        pixelsPerUnit: this._pixelsPerUnit,
      });
    }
  }

  registerSpriteContent(options: {
    sprites: Readonly<Record<string, SpritePayload>> | ReadonlyMap<string, SpritePayload>;
    spriteAnimations:
      | Readonly<Record<string, SpriteAnimationPayload>>
      | ReadonlyMap<string, SpriteAnimationPayload>;
    pixelsPerUnit?: number;
  }): void {
    this.sprites =
      options.sprites instanceof Map
        ? new Map(options.sprites)
        : new Map(Object.entries(options.sprites));
    this.spriteAnimations =
      options.spriteAnimations instanceof Map
        ? new Map(options.spriteAnimations)
        : new Map(Object.entries(options.spriteAnimations));
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this._pixelsPerUnit = options.pixelsPerUnit;
    }
    this.mainSync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this._pixelsPerUnit,
    });
    for (const sync of this.layerSyncs()) {
      sync.setSpriteContent({
        sprites: this.sprites,
        spriteAnimations: this.spriteAnimations,
        pixelsPerUnit: this._pixelsPerUnit,
      });
    }
  }

  registerModelContent(options: {
    models: Readonly<Record<string, ModelPayload>> | ReadonlyMap<string, ModelPayload>;
    complexMeshes?:
      | Readonly<Record<string, CollisionTriangleMesh>>
      | ReadonlyMap<string, CollisionTriangleMesh>;
  }): void {
    this.models =
      options.models instanceof Map
        ? new Map(options.models)
        : new Map(Object.entries(options.models));
    const provided = options.complexMeshes
      ? options.complexMeshes instanceof Map
        ? options.complexMeshes
        : new Map(Object.entries(options.complexMeshes))
      : new Map<string, CollisionTriangleMesh>();
    // A new source union may now hold a Model the host could not cook before.
    this.unavailableComplexMeshes.clear();
    this.installComplexMeshes(provided);
  }

  registerComplexCollisionMeshes(meshes: ReadonlyMap<string, CollisionTriangleMesh>, unavailable: readonly string[] = []): void {
    for (const [guid, mesh] of meshes) {
      this.pendingComplexMeshes.delete(guid);
      this.demandComplexMeshes.set(guid, mesh);
    }
    for (const guid of unavailable) {
      this.pendingComplexMeshes.delete(guid);
      this.unavailableComplexMeshes.add(guid);
      if (this.warnedComplexMeshes.has(guid)) continue;
      this.warnedComplexMeshes.add(guid);
      const frameId = this.host.frameId();
      const diag: RuntimeDiagnostic = {
        code: "physics.complex_collision_unavailable",
        message: `Model ${guid} uses Use Complex Collision, but its collision mesh could not be cooked (source not loaded, or no triangles). The Mesh has no collider; preload the Model or use Use Simple Collision.`,
        severity: "warning",
        assetGuid: guid,
        frameId,
        tickIndex: this.host.world().clock.tickIndex,
      };
      this.host.recordDiagnostic(diag);
      this.host.emit({ type: "diagnostic", code: diag.code, message: diag.message, assetGuid: guid, frameId, severity: "warning" });
    }
    if (meshes.size > 0) this.installComplexMeshes(this.lastProvidedComplexMeshes);
  }

  /** Contacts from the main world, then each Scene Layer world in creation order, as Hit / Begin / End Overlap script events. */
  dispatchCollisionEvents(): void {
    this.dispatchContacts(this.mainSync);
    if (this.layerWorlds.size === 0) return;
    for (const entry of this.layerWorlds.values()) if (entry.sync) this.dispatchContacts(entry.sync);
  }

  /** Console `showcollision`. */
  setShowCollision(enabled: unknown): void {
    this.showCollision = Boolean(enabled);
    this.host.emit({
      type: "setShowCollision",
      enabled: this.showCollision,
    });
    if (this.showCollision) this.emitDebugColliders();
    else this.host.emit({ type: "debugColliders", colliders: [] });
  }

  /** The main world's colliders while the collision view is on. */
  emitDebugColliders(): void {
    if (!this.showCollision) return;
    this.host.emit({
      type: "debugColliders",
      colliders: this.mainSync.getBackend().listDebugColliders(),
    });
  }

  /** Created layer worlds, in creation order. */
  private *layerSyncs(): Generator<PhysicsWorldSync> {
    for (const entry of this.layerWorlds.values()) if (entry.sync) yield entry.sync;
  }

  /** One layer instance's 2D world: native once `load` initialized Rapier, else software. */
  private createLayerSync(layerGuid: string, gravity: Vec3Tuple): PhysicsWorldSync {
    const backend = this.nativeLayerBackend?.(vec3(gravity)) ?? createSoftwarePhysicsBackend("2d", vec3(gravity));
    const sync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId === layerGuid && this.host.overlayActorReady(actor),
      deferUnsupportedConstraints: !this.preferSoftwarePhysics && backend instanceof SoftwarePhysicsBackend,
      skipEmptySteps: true,
    });
    this.bindContent(sync);
    return sync;
  }

  private bindContent(sync: PhysicsWorldSync): void {
    sync.water.setContent(this.waters);
    sync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this._pixelsPerUnit,
    });
    sync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this._pixelsPerUnit,
    });
    sync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
    });
    sync.setMissingComplexMeshHandler(this.missingComplexMesh);
  }

  /** `loadModels` meshes win; on-demand answers fill the rest for the whole session. */
  private installComplexMeshes(provided: ReadonlyMap<string, CollisionTriangleMesh>): void {
    // Own the index: an in-process host may clear its map when it releases sources.
    this.lastProvidedComplexMeshes = new Map(provided);
    this.complexMeshes = new Map([...this.demandComplexMeshes, ...provided]);
    this.mainSync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
    });
    for (const sync of this.layerSyncs()) {
      sync.setModelContent({
        models: this.models,
        complexMeshes: this.complexMeshes,
      });
    }
  }

  private dispatchContacts(sync: PhysicsWorldSync): void {
    const events = sync.getBackend().pollContacts();
    const world = this.host.world();
    for (const event of events) {
      const actorA = world.findActor(event.actorAId);
      const actorB = world.findActor(event.actorBId);
      if (!actorA || !actorB || actorA.destroyed || actorB.destroyed) continue;
      if (!this.host.canTickActor(actorA) || !this.host.canTickActor(actorB)) continue;
      if (event.kind === "hit") {
        this.dispatchHit(
          actorA,
          actorB,
          event.location,
          event.normal,
          event.colliderAId,
        );
        this.dispatchHit(actorB, actorA, event.location, {
          x: -event.normal.x,
          y: -event.normal.y,
          z: -event.normal.z,
        }, event.colliderBId);
      } else if (event.kind === "overlapBegin") {
        this.dispatchOverlap(actorA, actorB, "onBeginOverlap", event.colliderAId);
        this.dispatchOverlap(actorB, actorA, "onBeginOverlap", event.colliderBId);
      } else if (event.kind === "overlapEnd") {
        this.dispatchOverlap(actorA, actorB, "onEndOverlap", event.colliderAId);
        this.dispatchOverlap(actorB, actorA, "onEndOverlap", event.colliderBId);
      }
    }
  }

  private dispatchHit(
    self: Actor,
    other: Actor,
    location: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
    colliderId?: string,
  ): void {
    if (!self.generateHitEvents) return;
    this.host.scripts().invokeEvent(
      self.classId,
      "onHit",
      self,
      {
        hitResult: {
          Hit: true,
          Location: location,
          Normal: normal,
          Actor: other,
          Distance: 0,
        },
        otherActor: other,
        location: location,
        normal: normal,
      },
      componentIdFromColliderPhysicsId(colliderId),
    );
  }

  private dispatchOverlap(
    self: Actor,
    other: Actor,
    event: "onBeginOverlap" | "onEndOverlap",
    colliderId?: string,
  ): void {
    if (!self.generateOverlapEvents) return;
    this.host.scripts().invokeEvent(
      self.classId,
      event,
      self,
      {
        instigator: other,
      },
      componentIdFromColliderPhysicsId(colliderId),
    );
  }
}
