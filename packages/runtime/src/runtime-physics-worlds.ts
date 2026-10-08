import type { CommandMessage } from "@babylonslate/bridge";
import {
  createDefaultSceneSettings,
  normalizeWaterDefinition,
  type CollisionTriangleMesh,
  type SerializedScene,
  type WaterDefinition,
} from "@babylonslate/core";
import type { ModelPayload, SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload } from "@babylonslate/assets";
import type { Actor, World } from "@babylonslate/object-model";
import {
  createPhysicsBackend,
  createSoftwarePhysicsBackend,
  SoftwarePhysicsBackend,
  type PhysicsBackend,
  type PhysicsWorldKind,
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
  /** Without Scene Layer documents no overlay actor can exist. */
  hasSceneLayerDocuments(): boolean;
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

/**
 * The session's two physics worlds: the main Scene world (3D or 2D, replaced
 * when the native backend loads or a Scene changes its world kind) and the
 * Scene Layer 2D world. Owns backend selection and swaps, gravity, the
 * tile/sprite/model/water content both worlds collide with, complex-collision
 * mesh requests, contact dispatch to scripts and the collision debug view.
 * The driver keeps the step's place in the tick and reads `main` / `overlay`
 * lazily, since both are replaced.
 */
export class RuntimePhysicsWorlds implements RuntimeSubsystem {
  private mainSync: PhysicsWorldSync;
  private overlaySync: PhysicsWorldSync;
  private worldKind: PhysicsWorldKind;
  private generation = 0;
  private currentGravity: Vec3Tuple;
  private readonly overlayGravity = [...createDefaultSceneSettings("2d").gravity] as Vec3Tuple;
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
    this.overlaySync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend("2d", vec3(this.overlayGravity)),
      {
        actorFilter: (actor) => actor.sceneLayerId != null && this.host.overlayActorReady(actor),
        deferUnsupportedConstraints: !this.preferSoftwarePhysics,
      },
    );
    this.mainSync.setMissingComplexMeshHandler(this.missingComplexMesh);
    this.overlaySync.setMissingComplexMeshHandler(this.missingComplexMesh);
  }

  /** Main-Scene physics; replaced by `load`, `installScene` and `prepareScene`. */
  get main(): PhysicsWorldSync { return this.mainSync; }
  /** Scene Layer (2D overlay) physics; replaced by `load`. */
  get overlay(): PhysicsWorldSync { return this.overlaySync; }
  /** The main Scene's world kind. */
  get kind(): PhysicsWorldKind { return this.worldKind; }
  /** The main Scene's gravity (replaced, never mutated). */
  get gravity(): Vec3Tuple { return this.currentGravity; }
  get preferSoftware(): boolean { return this.preferSoftwarePhysics; }
  get pixelsPerUnit(): number { return this._pixelsPerUnit; }

  /** The world that simulates this actor: Scene Layer actors use the overlay. */
  forActor(actor: Actor): PhysicsWorldSync {
    return actor.sceneLayerId ? this.overlaySync : this.mainSync;
  }

  gravityFor(actor: Actor): Vec3Tuple {
    return actor.sceneLayerId ? this.overlayGravity : this.currentGravity;
  }

  /** Stop, phase 2: release both worlds. */
  dispose(): void {
    this.mainSync.dispose();
    this.overlaySync.dispose();
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
    let overlayBackend: PhysicsBackend;
    try {
      overlayBackend = await createPhysicsBackend({
        kind: "2d",
        // Without layer documents this session cannot create overlay actors.
        preferSoftware: !this.host.hasSceneLayerDocuments(),
        gravity: vec3(this.overlayGravity),
        allowSoftwareFallback: false,
      });
    } catch (error) {
      backend.dispose();
      throw error;
    }

    if (!current()) {
      backend.dispose();
      overlayBackend.dispose();
      throw sceneRealizationCancelled();
    }
    backend.setGravity(vec3(this.currentGravity));
    const world = this.host.world();
    const physicsSync = new PhysicsWorldSync(backend, {
      actorFilter: (actor) => actor.sceneLayerId == null && this.host.mainActorReady(actor),
    });
    const overlayPhysicsSync = new PhysicsWorldSync(overlayBackend, {
      actorFilter: (actor) => actor.sceneLayerId != null && this.host.overlayActorReady(actor),
    });
    try {
      this.bindContent(physicsSync);
      physicsSync.syncFromWorld(world);
      this.bindContent(overlayPhysicsSync);
      overlayPhysicsSync.syncFromWorld(world);
    } catch (error) {
      physicsSync.dispose();
      overlayPhysicsSync.dispose();
      throw error;
    }
    this.mainSync.dispose();
    this.overlaySync.dispose();
    this.mainSync = physicsSync;
    this.overlaySync = overlayPhysicsSync;
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

  setOverlayGravity(gravity: { x: number; y: number; z: number }): void {
    this.overlaySync.getBackend().setGravity(gravity);
  }

  /** Main-Scene step; movement motors run inside it. Water bodies then publish the water clock. */
  stepMain(dt: number, tickIndex: number, beforeStep: (sync: PhysicsWorldSync) => unknown): void {
    const time = tickIndex * dt;
    this.mainSync.step(dt, this.host.world(), time, -this.currentGravity[1], () => beforeStep(this.mainSync));
    if (this.mainSync.water.hasBodies) this.host.emit({ type: "waterTime", seconds: time });
  }

  stepOverlay(dt: number, beforeStep: (sync: PhysicsWorldSync) => unknown): void {
    this.overlaySync.step(dt, this.host.world(), undefined, undefined, () => beforeStep(this.overlaySync));
  }

  /** Bind the current content to both worlds. */
  bindAll(): void {
    this.bindContent(this.mainSync);
    this.bindContent(this.overlaySync);
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
    this.overlaySync.setTileContent({
      tilemaps: this.tilemaps,
      tilesets: this.tilesets,
      pixelsPerUnit: this._pixelsPerUnit,
    });
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
    this.overlaySync.setSpriteContent({
      sprites: this.sprites,
      spriteAnimations: this.spriteAnimations,
      pixelsPerUnit: this._pixelsPerUnit,
    });
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

  /** Contacts from the main world, then the overlay, as Hit / Begin / End Overlap script events. */
  dispatchCollisionEvents(): void {
    this.dispatchContacts(this.mainSync);
    this.dispatchContacts(this.overlaySync);
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
    this.overlaySync.setModelContent({
      models: this.models,
      complexMeshes: this.complexMeshes,
    });
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
