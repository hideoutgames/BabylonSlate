import { WaterWorld } from "./water-world";
import { dynamicRuntimeGeometry } from "./dynamic-runtime-mesh";
import { DynamicMeshCollisionCache, dynamicMeshCollisionDescriptor } from "./dynamic-mesh-collision";
import { landscapeCollisionMesh, normalizeWaterBuoyancy, parseMovementProperties, sameCollisionTriangleMesh, type CollisionTriangleMesh, type MovementProperties, type Transform } from "@babylonslate/core";
import type {
  ColliderDesc,
  ColliderLocalTransform,
  LineTraceOptions,
  PhysicsBackend,
  PhysicsTransform,
  Vec3,
  TeleportOptions,
} from "@babylonslate/physics";
import {
  decodeTileGid,
  parseMeshCollisionLayer,
  parseMeshCollisionMask,
  parseMeshCollisionMode,
  resolveMeshCollisions,
  spriteAnimationFrameAt,
  spriteClipFrameAt,
  spriteCollisionToBox2d,
  tilemapChunkChains,
  tilemapTilesetGuids,
  type ModelPayload,
  type SpriteAnimationPayload,
  type SpritePayload,
  type TilemapPayload,
  type TilesetPayload,
} from "@babylonslate/assets";
import {
  parseColliderProperties,
  parseRigidBodyProperties,
  bakeColliderLocal,
  multiplyQuat,
  rotateQuatVec,
  type ColliderShape,
} from "@babylonslate/physics";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import {
  PreparedColliderGeometry,
  sameDescriptor,
  physicsChainTransforms,
  physicsWorldTransforms,
} from "./physics-preparation";
import { componentColliderPhysicsId, hostedColliderPhysicsId } from "./physics-collider-id";
import { PhysicsConstraintSync } from "./physics-constraint-sync";
import {
  actorParentGuid,
  composeParentChildTransform,
  copyTransform,
  inverseQuaternion,
  multiplyQuaternion,
  relativeTransform,
  rotateVector,
  type ActorTransformMap,
} from "./actor-world-transform";

/**
 * Keeps `@babylonslate/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent, MeshComponent collision, tilemap
 * collision, enabled Landscapes, or a Blocking Volume.
 */
export class PhysicsWorldSync {
  private readonly dynamicMeshCollisions = new DynamicMeshCollisionCache();
  readonly water = new WaterWorld();
  private readonly backend: PhysicsBackend;
  private readonly actorFilter: (actor: Actor) => boolean;
  private readonly skipEmptySteps: boolean;
  private readonly constraints: PhysicsConstraintSync;
  private readonly suppressedActors = new WeakSet<Actor>();
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private readonly movementControllerDescriptors = new Map<string, readonly unknown[]>();
  private readonly actorById = new Map<string, Actor>();
  private readonly bodyOwnerByActor = new Map<string, Actor>();
  private readonly preparedByActor = new Map<
    string,
    {
      actor: Actor;
      descriptor: readonly unknown[];
      colliders: Map<string, ColliderDesc>;
    }
  >();
  private readonly geometryByComponent = new WeakMap<
    ActorComponent,
    Map<string, PreparedColliderGeometry>
  >();
  private readonly ordinaryByComponent = new WeakMap<
    ActorComponent,
    { shapeSource: unknown; shape: ColliderShape }
  >();
  private readonly meshSources = new WeakMap<
    ActorComponent,
    {
      descriptor: readonly unknown[];
      collisions: ReturnType<typeof resolveMeshCollisions>;
    }
  >();
  private readonly landscapeSources = new WeakMap<ActorComponent, {
    descriptor: readonly unknown[];
    shape: ReturnType<typeof landscapeCollisionMesh>;
  }>();
  private readonly rigidProperties = new WeakMap<
    ActorComponent,
    {
      descriptor: readonly unknown[];
      value: ReturnType<typeof parseRigidBodyProperties>;
    }
  >();
  private readonly modelContentIdentities = new Map<string, string>();
  private readonly appliedBodyProperties = new Map<
    string,
    {
      component: ActorComponent | null;
      value: ReturnType<typeof parseRigidBodyProperties>;
    }
  >();
  private readonly staticPoses = new Map<string, readonly unknown[]>();
  /**
   * Collidable static actors whose solid shapes their nearest dynamic or
   * kinematic ancestor's body hosts, and each host's children in world order.
   * The per-tick pass rebuilds both; call-time paths adjust one actor.
   */
  private readonly hostByActor = new Map<string, Actor>();
  private readonly hostedByHost = new Map<string, Actor[]>();
  // Per-tick scratch. Descriptors are compared in place and copied only when
  // they change, so a stored descriptor is never a scratch array.
  private readonly passSources = new Map<Actor, ActorComponent | null>();
  private readonly passHosts = new Map<Actor, Actor | null>();
  private readonly ancestorScratch: Actor[] = [];
  private readonly chainScratch: Actor[] = [];
  private readonly hostedScratch = new Map<string, ColliderDesc>();
  private readonly liveActors = new Set<string>();
  private readonly collisionScratch = new DescriptorScratch();
  private readonly rigidScratch: unknown[] = [];
  private readonly meshScratch: unknown[] = [];
  private readonly poseScratch: unknown[] = [];
  private readonly bodyPoses = new Map<string, PhysicsTransform>();
  private readonly readbackWorld = new Map<string, Transform>();
  private spriteInstallation = 0;
  private tileInstallation = 0;
  private actors: readonly Actor[] = [];
  /** The live world whose `findActor` answers call-time parent lookups. */
  private world: World | null = null;
  /**
   * The last pre-step composition. Only that pass, its constraint sync and the
   * Movement step hook (until `passStale`) and readback that follow it in
   * `step` read this map; call-time writes and queries resolve their own chains.
   */
  private worldTransforms: ActorTransformMap = new Map();
  /**
   * Set when a script pose write (`teleportActor`, `moveCharacter`) ran since
   * the last pre-step composition. Movement motors that run after such a write
   * in a transition event's script resolve their chains instead of the pass.
   */
  private passStale = false;
  private tilemaps = new Map<string, TilemapPayload>();
  private tilesets = new Map<string, TilesetPayload>();
  private sprites = new Map<string, SpritePayload>();
  private spriteAnimations = new Map<string, SpriteAnimationPayload>();
  private spriteClipByActor = new WeakMap<
    Actor,
    {
      assetGuid: string;
      clipName: string;
      normalisedTime: number;
    }
  >();
  private tilemapCollidersByActor = new Map<
    string,
    {
      component: ActorComponent;
      assetGuid: string | null;
      colliders: readonly ColliderDesc[];
    }
  >();
  private models = new Map<string, ModelPayload>();
  private complexMeshes = new Map<string, CollisionTriangleMesh>();
  private onMissingComplexMesh: ((assetGuid: string) => void) | null = null;
  private pixelsPerUnit = 100;

  constructor(
    backend: PhysicsBackend,
    options?: {
      actorFilter?: (actor: Actor) => boolean;
      /** Runtime boot only: authored constraints wait for the native replacement. */
      deferUnsupportedConstraints?: boolean;
      /**
       * Skip the native step and readback while the world holds no actor body.
       * Only for worlds whose backend has no other users (Scene Layer worlds).
       */
      skipEmptySteps?: boolean;
    },
  ) {
    this.backend = backend;
    this.skipEmptySteps = options?.skipEmptySteps ?? false;
    this.actorFilter = options?.actorFilter ?? (() => true);
    this.constraints = new PhysicsConstraintSync(backend, options?.deferUnsupportedConstraints);
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  /** Capture native center-of-mass motion before replacing the actor's body. */
  getActorVelocity(actor: Actor) {
    if (this.bodyOwnerByActor.get(actor.guid) !== actor) return null;
    const bodyId = this.bodyByActor.get(actor.guid);
    return bodyId ? this.backend.getBodyVelocity(bodyId) : null;
  }

  /** An articulated ragdoll replaces the actor's ordinary body and colliders. */
  suppressActorBody(actor: Actor, suppressed: boolean): void {
    if (suppressed) {
      this.suppressedActors.add(actor);
      if (this.bodyOwnerByActor.get(actor.guid) === actor) this.retireActor(actor.guid);
    } else this.suppressedActors.delete(actor);
  }

  setTileContent(options: {
    tilemaps:
      | ReadonlyMap<string, TilemapPayload>
      | Readonly<Record<string, TilemapPayload>>;
    tilesets:
      | ReadonlyMap<string, TilesetPayload>
      | Readonly<Record<string, TilesetPayload>>;
    pixelsPerUnit?: number;
  }): void {
    const tilemaps = ownedContentMap(options.tilemaps);
    const tilesets = ownedContentMap(options.tilesets);
    this.tileInstallation++;
    this.tilemaps = tilemaps;
    this.tilesets = tilesets;
    this.tilemapCollidersByActor.clear();
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  setSpriteContent(options: {
    sprites:
      | ReadonlyMap<string, SpritePayload>
      | Readonly<Record<string, SpritePayload>>;
    spriteAnimations:
      | ReadonlyMap<string, SpriteAnimationPayload>
      | Readonly<Record<string, SpriteAnimationPayload>>;
    pixelsPerUnit?: number;
  }): void {
    const sprites = ownedContentMap(options.sprites);
    const spriteAnimations = ownedContentMap(options.spriteAnimations);
    this.spriteInstallation++;
    this.sprites = sprites;
    this.spriteAnimations = spriteAnimations;
    if (options.pixelsPerUnit && options.pixelsPerUnit > 0) {
      if (this.pixelsPerUnit !== options.pixelsPerUnit) {
        this.tileInstallation++;
        this.tilemapCollidersByActor.clear();
      }
      this.pixelsPerUnit = options.pixelsPerUnit;
    }
  }

  setModelContent(options: {
    models:
      | ReadonlyMap<string, ModelPayload>
      | Readonly<Record<string, ModelPayload>>;
    complexMeshes?:
      | ReadonlyMap<string, CollisionTriangleMesh>
      | Readonly<Record<string, CollisionTriangleMesh>>;
  }): void {
    const models = toMap(options.models);
    const meshes = options.complexMeshes
      ? toMap(options.complexMeshes)
      : new Map<string, CollisionTriangleMesh>();
    const nextModels = new Map<string, ModelPayload>();
    const nextMeshes = new Map<string, CollisionTriangleMesh>();
    const identities = new Map<string, string>();
    // These full-content comparisons belong to installation, never a tick.
    // Exact collision content gives each retained immutable source its identity;
    // unrelated material metadata cannot invalidate prepared physics geometry.
    for (const [guid, model] of models) {
      const identity = JSON.stringify([model.simpleColliders, model.importScale]);
      nextModels.set(
        guid,
        this.modelContentIdentities.get(guid) === identity && this.models.has(guid)
          ? this.models.get(guid)!
          : structuredClone(model),
      );
      identities.set(guid, identity);
    }
    for (const [guid, mesh] of meshes) {
      const installed = this.complexMeshes.get(guid);
      nextMeshes.set(
        guid,
        installed && sameCollisionTriangleMesh(installed, mesh)
          ? installed
          : { positions: mesh.positions.slice(), indices: mesh.indices.slice() },
      );
    }
    this.modelContentIdentities.clear();
    for (const [guid, identity] of identities)
      this.modelContentIdentities.set(guid, identity);
    this.models = nextModels;
    this.complexMeshes = nextMeshes;
  }

  /**
   * Called (once per resolution) when a Complex Collision MeshComponent names a
   * Model with no installed mesh, so the host can cook it on demand. The
   * component contributes no collider until the mesh is installed; the next
   * sync then rebuilds the actor's body.
   */
  setMissingComplexMeshHandler(handler: ((assetGuid: string) => void) | null): void {
    this.onMissingComplexMesh = handler;
  }

  setActorSpriteClip(
    actor: Actor,
    clip: {
      assetGuid: string;
      clipName: string;
      normalisedTime: number;
    } | null,
  ): void {
    if (!clip) {
      this.spriteClipByActor.delete(actor);
      return;
    }
    this.spriteClipByActor.set(actor, { ...clip });
  }

  dispose(): void {
    this.constraints.dispose();
    this.backend.dispose();
    this.bodyByActor.clear();
    this.characterByActor.clear();
    this.movementControllerDescriptors.clear();
    this.preparedByActor.clear();
    this.bodyOwnerByActor.clear();
    this.actorById.clear();
    this.staticPoses.clear();
    this.hostByActor.clear();
    this.hostedByHost.clear();
    this.passSources.clear();
    this.passHosts.clear();
    this.liveActors.clear();
    this.bodyPoses.clear();
    this.readbackWorld.clear();
    this.appliedBodyProperties.clear();
    this.modelContentIdentities.clear();
    this.tilemapCollidersByActor.clear();
    this.spriteClipByActor = new WeakMap();
    this.models.clear();
    this.complexMeshes.clear();
    this.tilemaps.clear();
    this.tilesets.clear();
    this.sprites.clear();
    this.spriteAnimations.clear();
    this.actors = [];
    this.world = null;
    this.worldTransforms = new Map();
    this.passStale = false;
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    this.bindWorld(world);
    this.indexActors();
    this.worldTransforms = physicsWorldTransforms(
      this.actors,
      this.actorById,
      this.backend.kind,
      this.actorFilter,
    );
    this.passStale = false;
    const sources = this.passSources;
    sources.clear();
    for (const actor of this.actors) {
      if (actor.destroyed) continue;
      if (!this.actorFilter(actor) || this.suppressedActors.has(actor)) continue;
      const source = this.classifyActor(actor);
      if (source !== false) sources.set(actor, source);
    }
    // Hosts are known before any body changes, so a compound and the bodies
    // its children leave or regain are reconciled in the same pass.
    this.assignHosts(sources);
    const live = this.liveActors;
    live.clear();
    for (const [actor, source] of sources) {
      // A hosted actor keeps a body of its own only for its trigger colliders.
      if (this.hostByActor.has(actor.guid) && !this.hasTriggerCollider(actor)) continue;
      live.add(actor.guid);
      this.reconcileActor(actor, source, this.passWorldTransform);
    }
    // Hosted IDs are host-qualified, so retiring bodies last cannot collide
    // with shapes that moved onto or off a compound in this pass.
    for (const actorId of this.bodyByActor.keys()) {
      if (!live.has(actorId)) this.retireActor(actorId);
    }
    live.clear();
    sources.clear();
    this.syncConstraints((actor) => this.passWorldTransform(actor).scale);
  }

  /**
   * Reconcile one actor at call time as the per-tick pass would: create, retire
   * or update its body policy, pose and colliders from its current ancestor
   * chain. Joints are reconciled only when its body was created. Other actors,
   * including ones whose ragdolls changed meanwhile, wait for the next step.
   */
  syncActor(actor: Actor, world: World): void {
    this.bindWorld(world);
    if (world.findActor(actor.guid) !== actor) return;
    const source =
      actor.destroyed || !this.actorFilter(actor) || this.suppressedActors.has(actor)
        ? false
        : this.classifyActor(actor);
    const host = this.refreshLiveHost(actor, source);
    if (source === false) {
      // Retiring a body already releases the joints attached to it.
      if (this.bodyByActor.has(actor.guid)) this.retireActor(actor.guid);
      return;
    }
    if (host && this.applyHostedActor(actor, host)) return;
    let transforms: Map<string, Transform> | undefined;
    const created = this.reconcileActor(actor, source, (target) =>
      (transforms ??= this.liveTransforms(target)).get(target.guid)!,
    );
    if (created) this.syncLiveConstraints();
  }

  /**
   * Body membership, policy, pose and colliders for one live actor whose body
   * `source` was classified by the caller. `world` resolves its current world
   * pose; it is read only when the actor owns or creates a body. Returns true
   * when this call created the body.
   */
  private reconcileActor(
    actor: Actor,
    source: ActorComponent | null,
    world: (actor: Actor) => Transform,
  ): boolean {
    // Movement never coexists with RigidBody or buoyancy, so one source suffices.
    const movement = source?.classId === "MovementComponent" ? source : null;
    const rigid = movement ? null : source;
    if (
      this.bodyOwnerByActor.has(actor.guid) &&
      this.bodyOwnerByActor.get(actor.guid) !== actor
    )
      this.retireActor(actor.guid);
    let created = false;
    if (!this.bodyByActor.has(actor.guid)) {
      this.createForActor(actor, world);
      created = this.bodyByActor.has(actor.guid);
    } else {
      const bodyId = this.bodyByActor.get(actor.guid)!;
      const pose = world(actor);
      if (movement) {
        this.applyBodyPolicy(actor.guid, bodyId, movement, MOVEMENT_BODY_PROPERTIES);
        this.backend.setBodyTargetTransform(bodyId, physicsPose(pose));
      } else if (rigid) {
        const props = this.rigidProps(rigid);
        this.applyBodyPolicy(actor.guid, bodyId, rigid, props);
        if (props.motionType === "kinematic") {
          this.backend.setBodyTargetTransform(bodyId, physicsPose(pose));
        } else if (props.motionType === "static") {
          this.syncStaticPose(actor, bodyId, pose);
        }
      } else {
        this.applyBodyPolicy(
          actor.guid,
          bodyId,
          null,
          STATIC_BODY_PROPERTIES,
        );
        this.syncStaticPose(actor, bodyId, pose);
      }
      this.applyActorColliders(actor, bodyId, pose, movement);
    }
    if (!movement && this.movementControllerDescriptors.has(actor.guid)) {
      this.backend.destroyCharacterController(actor.guid);
      this.characterByActor.delete(actor.guid);
      this.movementControllerDescriptors.delete(actor.guid);
    }
    return created;
  }

  /**
   * Assign each collidable static body source to its nearest dynamic or
   * kinematic ancestor for this pass, in world order. Static and nonphysics
   * ancestors in between do not host; a destroyed parent ends the chain.
   */
  private assignHosts(sources: ReadonlyMap<Actor, ActorComponent | null>): void {
    this.hostByActor.clear();
    this.hostedByHost.clear();
    const memo = this.passHosts;
    memo.clear();
    const motion = (actor: Actor): BodyMotion => {
      const source = sources.get(actor);
      return source === undefined ? "none" : this.isStaticSource(source) ? "static" : "simulated";
    };
    const lookup = (guid: string) => this.actorById.get(guid);
    for (const [actor, source] of sources) {
      if (!this.isStaticSource(source)) continue;
      // The memoized ancestor walk comes first, so only statics under a
      // simulated body pay for a second component scan.
      const host = this.simulatedAncestor(actor, motion, lookup, memo);
      if (host && this.hasSolidCollision(actor)) this.hostActor(actor, host);
    }
    memo.clear();
  }

  /**
   * The nearest ancestor whose body is dynamic or kinematic. `memo` maps each
   * visited ancestor to the nearest such actor among itself and its own
   * ancestors, so one pass walks every chain once.
   */
  private simulatedAncestor(
    actor: Actor,
    motion: (actor: Actor) => BodyMotion,
    lookup: (guid: string) => Actor | undefined,
    memo?: Map<Actor, Actor | null>,
  ): Actor | null {
    const visited = this.ancestorScratch;
    visited.length = 0;
    let host: Actor | null = null;
    let current = actor;
    // Composition rejects parent cycles first; the bound only stops a stale call.
    for (let depth = 0; depth <= this.actors.length; depth++) {
      const parentId = actorParentGuid(current);
      const parent = parentId ? lookup(parentId) : undefined;
      if (!parent || parent.destroyed) break;
      const known = memo?.get(parent);
      if (known !== undefined) {
        host = known;
        break;
      }
      visited.push(parent);
      if (motion(parent) === "simulated") {
        host = parent;
        break;
      }
      current = parent;
    }
    if (memo) for (const ancestor of visited) memo.set(ancestor, host);
    visited.length = 0;
    return host;
  }

  /** Inserted in world order, which call-time additions also keep. */
  private hostActor(actor: Actor, host: Actor): void {
    this.hostByActor.set(actor.guid, host);
    let hosted = this.hostedByHost.get(host.guid);
    if (!hosted) this.hostedByHost.set(host.guid, (hosted = []));
    let index = hosted.length;
    while (index > 0 && hosted[index - 1]!.spawnIndex > actor.spawnIndex) index--;
    hosted.splice(index, 0, actor);
  }

  /**
   * Call-time hosting of one actor from its current chain. Leaving a host
   * rebuilds that host's compound now; callers rebuild the new host.
   */
  private refreshLiveHost(actor: Actor, source: ActorComponent | null | false): Actor | null {
    const host =
      source !== false && this.isStaticSource(source) && this.hasSolidCollision(actor)
        ? this.simulatedAncestor(actor, this.liveMotion, this.findLiveActor)
        : null;
    const previous = this.hostByActor.get(actor.guid);
    if (previous === host) return host;
    if (previous) {
      const hosted = this.hostedByHost.get(previous.guid);
      const index = hosted?.indexOf(actor) ?? -1;
      if (index >= 0) hosted!.splice(index, 1);
      this.hostByActor.delete(actor.guid);
    }
    if (host) this.hostActor(actor, host);
    if (previous) this.applyHostColliders(previous);
    return host;
  }

  /**
   * Call-time update of a hosted actor: its solid shapes move on the host's
   * compound, resolved from its own current chain. Returns true when it then
   * needs no body of its own, because it has no trigger colliders.
   */
  private applyHostedActor(actor: Actor, host: Actor): boolean {
    this.applyHostColliders(host, this.liveTransforms(actor));
    if (this.hasTriggerCollider(actor)) return false;
    if (this.bodyByActor.has(actor.guid)) this.retireActor(actor.guid);
    return true;
  }

  /** Rebuild a live host's compound; `transforms` must include its chain. */
  private applyHostColliders(host: Actor, transforms?: ReadonlyMap<string, Transform>): void {
    if (this.bodyOwnerByActor.get(host.guid) !== host) return;
    const bodyId = this.bodyByActor.get(host.guid);
    if (!bodyId) return;
    const pose = transforms?.get(host.guid) ?? this.liveTransforms(host).get(host.guid)!;
    this.applyActorColliders(host, bodyId, pose);
  }

  /** Call-time motion of a possible host, with the per-tick pass's eligibility. */
  private readonly liveMotion = (actor: Actor): BodyMotion => {
    if (actor.destroyed || !this.actorFilter(actor) || this.suppressedActors.has(actor) ||
      this.findLiveActor(actor.guid) !== actor) return "none";
    const source = this.classifyActor(actor);
    return source === false ? "none" : this.isStaticSource(source) ? "static" : "simulated";
  };

  private isStaticSource(source: ActorComponent | null): boolean {
    return source === null ||
      (source.classId !== "MovementComponent" && this.rigidProps(source).motionType === "static");
  }

  /** Whether the actor supplies a non-trigger collider, the shapes a host takes over. */
  private hasSolidCollision(actor: Actor): boolean {
    const is3d = this.backend.kind === "3d";
    for (const component of actor.components) {
      if (component.destroyed || component.owner !== actor) continue;
      switch (component.classId) {
        case "ColliderComponent":
          if (component.getVariable("isTrigger") !== true) return true;
          break;
        case "TilemapComponent":
        case "BlockingVolumeComponent":
          return true;
        case "MeshComponent":
          if (is3d && this.resolvedMeshCollisions(component).length > 0) return true;
          break;
        case "LandscapeComponent":
          if (is3d && component.getVariable("collisionsEnabled") === true) return true;
          break;
        case "DynamicRuntimeMeshComponent":
          if (is3d && component.getVariable("enableCollision") === true &&
            dynamicRuntimeGeometry(component)?.indices.length) return true;
          break;
      }
    }
    return false;
  }

  /** Matches `parseColliderProperties`, which accepts only `true`. */
  private hasTriggerCollider(actor: Actor): boolean {
    for (const component of actor.components)
      if (component.classId === "ColliderComponent" && !component.destroyed &&
        component.owner === actor && component.getVariable("isTrigger") === true) return true;
    return false;
  }

  /**
   * Shapes `host` takes over from its hosted children, each with its pose in
   * the host's body frame.
   */
  private hostedShapes(host: Actor, scale: Vec3): HostedShape[] | undefined {
    const hosted = this.hostedByHost.get(host.guid);
    if (!hosted?.length) return undefined;
    const shapes: HostedShape[] = [];
    for (const actor of hosted) {
      if (actor.destroyed || this.hostByActor.get(actor.guid) !== host) continue;
      const relative = this.hostRelativeTransform(host, scale, actor);
      if (relative) shapes.push({ actor, relative });
    }
    return shapes.length ? shapes : undefined;
  }

  /**
   * `actor`'s pose in `host`'s body frame: the local transforms from the host
   * down to the actor, composed under the host's world scale only. It never
   * reads the host's world pose, so a moving host keeps a bit-identical
   * descriptor and its compound is not rebuilt.
   */
  private hostRelativeTransform(host: Actor, scale: Vec3, actor: Actor): Transform | null {
    const chain = this.chainScratch;
    chain.length = 0;
    let current: Actor | undefined = actor;
    while (current !== host) {
      if (!current || current.destroyed || chain.length > this.actors.length) {
        chain.length = 0;
        return null;
      }
      chain.push(current);
      const parentId = actorParentGuid(current);
      current = parentId ? this.findLiveActor(parentId) : undefined;
    }
    let transform: Transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { ...scale },
    };
    for (let index = chain.length - 1; index >= 0; index--)
      transform = composeParentChildTransform(transform, chain[index]!.transform);
    chain.length = 0;
    return transform;
  }

  /** A hosted child's solid colliders, moved into the host's body frame. */
  private collectHostedColliders(
    host: Actor,
    bodyId: string,
    { actor, relative }: HostedShape,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const own = this.hostedScratch;
    own.clear();
    // Collected exactly as the child's own body would be, then re-attached.
    this.collectOwnColliders(actor, `body:${actor.guid}`, { ...relative.scale }, own);
    // Native bodies use unit rotations, as the child's own body did.
    const rotation = unitQuaternion(relative.rotation);
    for (const collider of own.values()) {
      if (collider.isTrigger) continue;
      const offset = collider.translation
        ? rotateQuatVec(rotation, collider.translation)
        : { x: 0, y: 0, z: 0 };
      const id = hostedColliderPhysicsId(collider.id, host.guid);
      colliders.set(id, {
        ...collider,
        id,
        bodyId,
        actorId: actor.guid,
        translation: {
          x: relative.position.x + offset.x,
          y: relative.position.y + offset.y,
          z: relative.position.z + offset.z,
        },
        rotation: collider.rotation ? multiplyQuat(rotation, collider.rotation) : rotation,
      });
    }
    own.clear();
  }

  private bindWorld(world: World): void {
    this.world = world;
    this.actors = world.getActors();
  }

  /** First live match, as the per-tick index answers; that index before any world is bound. */
  private readonly findLiveActor = (guid: string): Actor | undefined =>
    this.world ? this.world.findActor(guid) : this.actorById.get(guid);

  /**
   * Current world poses of `actor` and its own ancestor chain only, with the
   * pre-step pass's lookup, cycle and shear rules. Call-time writes and
   * queries use this: the pre-step composition predates this tick's script
   * writes, physics readback and navigation moves.
   */
  private liveTransforms(actor: Actor): Map<string, Transform> {
    return physicsChainTransforms([actor], this.findLiveActor, this.backend.kind);
  }

  /** An actor's pose in the last pre-step composition. */
  private readonly passWorldTransform = (actor: Actor): Transform =>
    this.worldTransforms.get(actor.guid) ?? actor.transform;

  /**
   * One membership scan per actor and tick. Returns false for an actor without
   * a body source, otherwise its rigid component (RigidBody, or buoyancy in 3D),
   * its Movement component (as `movementComponent` resolves it), or null for an
   * implicit static body. Mesh collision sources still resolve for every live
   * MeshComponent, and disabled dynamic meshes are released only when no
   * earlier source supplies a body, as before.
   */
  private classifyActor(actor: Actor): ActorComponent | null | false {
    const is3d = this.backend.kind === "3d";
    let rigidBody: ActorComponent | undefined;
    let buoyancy: ActorComponent | undefined;
    let movement: ActorComponent | undefined;
    let movementExcluded = false;
    let implicit = false;
    let dynamicMesh = false;
    for (const component of actor.components) {
      if (component.classId === "DynamicRuntimeMeshComponent") {
        dynamicMesh = true;
        continue;
      }
      if (component.destroyed || component.owner !== actor) continue;
      switch (component.classId) {
        case "RigidBodyComponent":
          rigidBody ??= component;
          movementExcluded = true;
          break;
        case "WaterBuoyancyComponent":
          buoyancy ??= component;
          movementExcluded = true;
          break;
        case "NavAgentComponent":
        case "RagdollComponent":
          movementExcluded = true;
          break;
        case "MovementComponent":
          // A second Movement component disables both.
          if (movement) movementExcluded = true;
          movement = component;
          break;
        case "TilemapComponent":
        case "BlockingVolumeComponent":
          implicit = true;
          break;
        case "MeshComponent":
          if (is3d && this.resolvedMeshCollisions(component).length > 0)
            implicit = true;
          break;
        case "LandscapeComponent":
          if (is3d && component.getVariable("collisionsEnabled") === true)
            implicit = true;
          break;
      }
    }
    const rigid = rigidBody ?? (is3d ? buoyancy : undefined);
    if (rigid) return rigid;
    if (movement && !movementExcluded) return movement;
    if (implicit) return null;
    return dynamicMesh && this.dynamicMeshPhysicsComponents(actor).length > 0
      ? null
      : false;
  }

  private syncConstraints(worldScale: (actor: Actor) => Vec3): void {
    this.constraints.sync({
      actors: this.actors,
      actorById: this.actorById,
      worldScale,
      bodies: this.bodyByActor,
      bodyOwners: this.bodyOwnerByActor,
      eligible: this.actorFilter,
      // A hosted actor's joints attach where its shapes are: on its host's body.
      hosting: {
        hostOf: (actor) => this.hostByActor.get(actor.guid),
        frame: (actor, host) => {
          const relative = this.hostRelativeTransform(host, worldScale(host), actor);
          return relative && { ...relative, rotation: unitQuaternion(relative.rotation) };
        },
      },
    });
  }

  /**
   * Call-time joint reconciliation. Finding constraint owners and targets still
   * scans and indexes the world, but only connected endpoints compose their
   * own ancestor chains for anchor scale, instead of every physics participant.
   */
  private syncLiveConstraints(): void {
    this.indexActors();
    const resolved = new Map<string, Transform>();
    this.syncConstraints((actor) => {
      let transform = resolved.get(actor.guid);
      if (!transform) {
        for (const [guid, entry] of this.liveTransforms(actor)) resolved.set(guid, entry);
        transform = resolved.get(actor.guid)!;
      }
      return transform.scale;
    });
  }

  private applyBodyPolicy(
    actorId: string,
    bodyId: string,
    component: ActorComponent | null,
    value: ReturnType<typeof parseRigidBodyProperties>,
  ): void {
    const applied = this.appliedBodyProperties.get(actorId);
    if (applied?.component === component && applied.value === value) return;
    this.backend.updateBody(bodyId, value);
    this.appliedBodyProperties.set(actorId, { component, value });
    this.staticPoses.delete(actorId);
  }

  /**
   * Static bodies follow their actor one way: readback never writes them, so
   * an unchanged composed pose stays bit-identical and is never re-teleported.
   * A pose moved by the actor or any ancestor is teleported once per change.
   */
  private syncStaticPose(actor: Actor, bodyId: string, world: Transform): void {
    // Same layout as `physicsPoseDescriptor`, which creation stores.
    const descriptor = this.poseScratch;
    descriptor[0] = world.position.x;
    descriptor[1] = world.position.y;
    descriptor[2] = world.position.z;
    descriptor[3] = world.rotation.x;
    descriptor[4] = world.rotation.y;
    descriptor[5] = world.rotation.z;
    descriptor[6] = world.rotation.w;
    if (sameDescriptor(this.staticPoses.get(actor.guid), descriptor)) return;
    this.backend.teleportBody(bodyId, physicsPose(world));
    this.staticPoses.set(actor.guid, descriptor.slice());
  }

  private indexActors(): void {
    this.actorById.clear();
    for (const actor of this.actors) this.actorById.set(actor.guid, actor);
  }

  private retireActor(actorId: string): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (bodyId) {
      this.constraints.retireBody(bodyId);
      this.backend.destroyBody(bodyId);
    }
    this.bodyByActor.delete(actorId);
    const owner = this.bodyOwnerByActor.get(actorId);
    this.bodyOwnerByActor.delete(actorId);
    this.staticPoses.delete(actorId);
    this.appliedBodyProperties.delete(actorId);
    this.characterByActor.delete(actorId);
    this.movementControllerDescriptors.delete(actorId);
    if (owner) this.spriteClipByActor.delete(owner);
    this.preparedByActor.delete(actorId);
    this.tilemapCollidersByActor.delete(actorId);
  }

  /**
   * `beforeStep` runs after this tick's composition and before simulation. A
   * hook may run scripts that change poses, parents or physics membership, so
   * readback then recomposes and revalidates the whole world. Only a hook that
   * returns `false` promises it ran no scripts and moved only its own bodies
   * (Movement motors), which keeps the chain-only readback.
   */
  step(dt: number, world: World, time = world.clock.tickIndex * dt, gravity = 9.81, beforeStep?: () => unknown): void {
    this.syncFromWorld(world);
    const recompose = beforeStep !== undefined && beforeStep() !== false;
    if (this.skipEmptySteps && this.bodyByActor.size === 0 && this.characterByActor.size === 0) return;
    if (this.backend.kind === "3d") {
      this.water.update(this.actors, time);
      if (this.water.hasBodies) for (const [actorId, bodyId] of this.bodyByActor) {
        const actor = this.actorById.get(actorId);
        const tuning = this.appliedBodyProperties.get(actorId)?.value;
        if (actor && tuning?.motionType === "dynamic")
          this.water.applyBuoyancy(actor, bodyId, this.backend, tuning.mass, gravity, dt);
      }
    }
    this.backend.step(dt);
    this.readBack(recompose);
  }

  /**
   * Gather every simulated native pose, then write actor-local poses. Static
   * bodies are skipped: they follow their actor, so authored depth, tilt and
   * quaternions stay as written and a static child keeps its local pose under a
   * moving parent. An unparented body copies its native pose without
   * composition; a parented body resolves only its own ancestor chain against
   * post-step parent body poses, where a static ancestor composes under its
   * own parent like a nonphysics actor. With `recompose`, the whole world is
   * recomposed and revalidated instead.
   */
  private readBack(recompose: boolean): void {
    const poses = this.bodyPoses;
    poses.clear();
    this.readbackWorld.clear();
    try {
      for (const [actorId, bodyId] of this.bodyByActor) {
        if (this.isStaticBody(actorId)) continue;
        const transform = this.backend.getBodyTransform(bodyId);
        if (transform) poses.set(actorId, transform);
      }
      const world = recompose
        ? physicsWorldTransforms(
            this.actors,
            this.actorById,
            this.backend.kind,
            this.actorFilter,
            poses,
          )
        : undefined;
      for (const [actorId, transform] of poses) {
        const actor = this.actorById.get(actorId);
        if (!actor || actor.destroyed) continue;
        let local: PhysicsTransform;
        if (world) local = actorLocalPhysicsTransform(transform, actor, world);
        else {
          const parentId = actorParentGuid(actor);
          const parent = parentId ? this.actorById.get(parentId) : undefined;
          // A body's resolved pose never reads its own local position or
          // rotation, so writing earlier bodies cannot change a later ancestor.
          local =
            parent && !parent.destroyed
              ? localPhysicsTransform(transform, this.readbackPose(parent), actor.transform)
              : transform;
        }
        Object.assign(actor.transform.position, local.position);
        Object.assign(actor.transform.rotation, local.rotation);
      }
    } finally {
      poses.clear();
      this.readbackWorld.clear();
    }
  }

  /**
   * Post-step world pose of a readback ancestor: a simulated body's native pose
   * with its composed scale, otherwise (nonphysics and static actors) the
   * authored composition under its resolved parent. A chain without simulated
   * bodies reuses this tick's pre-step composition,
   * whose inputs are unchanged and were already validated for cycles and shear:
   * without hook scripts, only Movement motors write poses after composition,
   * and those actors are bodies whose descendants recompose here.
   */
  private readbackPose(actor: Actor): Transform {
    const cached = this.readbackWorld.get(actor.guid);
    if (cached) return cached;
    const parentId = actorParentGuid(actor);
    const parent = parentId ? this.actorById.get(parentId) : undefined;
    const ancestor =
      parent && !parent.destroyed ? this.readbackPose(parent) : undefined;
    const body = this.bodyPoses.get(actor.guid);
    const authored = this.worldTransforms.get(actor.guid);
    const authoredParent =
      ancestor && parent ? this.worldTransforms.get(parent.guid) : undefined;
    let transform: Transform;
    if (body) {
      transform = {
        position: { ...body.position },
        rotation: { ...body.rotation },
        // Scale is unchanged by the step: reuse the pre-step composition,
        // which predates this readback's local rotation writes.
        scale: authored
          ? { ...authored.scale }
          : ancestor
            ? composeParentChildTransform(ancestor, actor.transform).scale
            : { ...actor.transform.scale },
      };
    } else if (authored && ancestor === authoredParent) {
      transform = authored;
    } else {
      transform = ancestor
        ? composeParentChildTransform(ancestor, actor.transform)
        : copyTransform(actor.transform);
    }
    this.readbackWorld.set(actor.guid, transform);
    return transform;
  }

  private queryOptions(options?: LineTraceOptions & { channel?: string }): LineTraceOptions | undefined {
    const channel = options?.channel;
    if (!channel || channel === "All") return options;
    if (channel === "Visibility") return { ...options, includeTriggers: false };
    const ignored = new Set(options?.ignoreActorIds);
    const matches = (actor: Actor) => {
      const motion = this.appliedBodyProperties.get(actor.guid)?.value.motionType ?? "static";
      return channel === "WorldStatic" ? motion === "static"
        : channel === "WorldDynamic" ? motion !== "static"
          : channel === "Pawn" ? this.movementComponent(actor) !== undefined : true;
    };
    for (const [actorId, actor] of this.bodyOwnerByActor)
      if (!this.hostByActor.has(actorId) && !matches(actor)) ignored.add(actorId);
    // Hosted shapes, and a hosted actor's own triggers, answer as their host.
    for (const [actorId, host] of this.hostByActor)
      if (!matches(host)) ignored.add(actorId);
    return { ...options, ignoreActorIds: [...ignored] };
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions & { channel?: string }) {
    return this.backend.lineTrace(start, end, this.queryOptions(options));
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions & { channel?: string }) {
    return this.backend.sphereOverlap(center, radius, this.queryOptions(options));
  }

  shapeSweep(
    shape: Parameters<PhysicsBackend["shapeSweep"]>[0],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions & { channel?: string },
  ) {
    return this.backend.shapeSweep(shape, start, end, this.queryOptions(options));
  }

  addImpulse(actorId: string, impulse: Vec3, strength?: number): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (!bodyId) return;
    this.backend.addImpulse(bodyId, impulse, strength);
  }

  /** Steering updates velocity through physics without replacing its pose. */
  setActorLinearVelocity(actorId: string, velocity: Partial<Vec3>): void {
    const bodyId = this.bodyByActor.get(actorId);
    if (bodyId) this.backend.setBodyLinearVelocity(bodyId, velocity);
  }

  /**
   * Explicit authored pose writes are visible to the next synchronous query.
   * Scripts and inspector writes may run before the next fixed tick and can
   * also change a parent, so the pose is resolved now, from the actor's own
   * ancestor chain only. An actor that neither owns nor can create a body
   * (a light, camera or prop without collision) returns before any composition.
   */
  teleportActor(actor: Actor, world: World, options?: TeleportOptions): void {
    // Even a body-less write moves its descendants, including Movement actors.
    this.passStale = true;
    if (actor.destroyed || !this.actorFilter(actor)) return;
    this.bindWorld(world);
    if (world.findActor(actor.guid) !== actor) return;
    if (
      this.bodyOwnerByActor.has(actor.guid) &&
      this.bodyOwnerByActor.get(actor.guid) !== actor
    )
      this.retireActor(actor.guid);
    // A hosted actor's write moves its shapes on its host's compound.
    const host = this.refreshLiveHost(actor, this.suppressedActors.has(actor) ? false : this.classifyActor(actor));
    if (host && this.applyHostedActor(actor, host)) return;
    let transforms: Map<string, Transform> | undefined;
    const current = (target: Actor) =>
      (transforms ??= this.liveTransforms(target)).get(target.guid)!;
    if (!this.bodyByActor.has(actor.guid)) this.createForActor(actor, current);
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return;
    const pose = current(actor);
    this.applyActorColliders(actor, bodyId, pose);
    // A static body has no velocity to preserve or reset. Rewriting its
    // unchanged pose would only refresh native membership and trigger pairs.
    if (this.isStaticBody(actor.guid)) this.syncStaticPose(actor, bodyId, pose);
    else this.backend.teleportBody(bodyId, physicsPose(pose), options);
  }

  private isStaticBody(actorId: string): boolean {
    return this.appliedBodyProperties.get(actorId)?.value.motionType === "static";
  }

  /** Apply mid-Play RigidBody / Collider inspector knobs to the live backend. */
  applyComponent(component: ActorComponent): void {
    const owner = component.owner;
    if (!owner || owner.destroyed || component.destroyed) return;
    if (!owner.components.includes(component) || !this.actorFilter(owner)) return;
    // A hosted actor's collision lives on its host's compound. Changes to its
    // motion type, or a collider becoming a trigger, re-host at the next step.
    const host = this.hostByActor.get(owner.guid);
    if (host && COLLIDER_REFRESH_CLASSES.has(component.classId) && this.findLiveActor(owner.guid) === owner)
      this.applyHostColliders(host, this.liveTransforms(owner));
    if (this.bodyOwnerByActor.get(owner.guid) !== owner) return;
    if (component.classId === "PhysicsConstraintComponent") {
      this.syncLiveConstraints();
      return;
    }
    const bodyId = this.bodyByActor.get(owner.guid);
    if (!bodyId) return;
    if (component.classId === "RigidBodyComponent") {
      const props = this.rigidProps(component);
      this.applyBodyPolicy(owner.guid, bodyId, component, props);
      return;
    }
    if (COLLIDER_REFRESH_CLASSES.has(component.classId) || component.classId === "MovementComponent") {
      // Collider scale and Movement capsule tilt follow the owner's current chain.
      this.applyActorColliders(owner, bodyId, this.liveTransforms(owner).get(owner.guid)!);
    }
  }

  /**
   * Lazy character controller keyed by actor guid. Applies the resolved
   * transform to the actor immediately so the next kinematic sync keeps it.
   * The world-to-local conversion uses the parent's pose at call time: scripts,
   * readback and navigation may have moved it since the last pre-step pass.
   */
  moveCharacter(
    actor: Actor,
    translation: Vec3,
    dt: number,
    offset?: number,
  ): void {
    this.passStale = true;
    if (actor.destroyed || !this.actorFilter(actor)) return;
    const owner = this.bodyOwnerByActor.get(actor.guid);
    if (owner && owner !== actor) return;
    let transforms: Map<string, Transform> | undefined;
    const current = () => (transforms ??= this.liveTransforms(actor));
    if (!this.bodyByActor.has(actor.guid)) {
      this.createForActor(actor, (target) => current().get(target.guid)!);
    }
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return;
    if (!this.characterByActor.has(actor.guid)) {
      const skin = offset != null && offset > 0 ? offset : 0.01;
      this.backend.createCharacterController({
        id: actor.guid,
        bodyId,
        offset: skin,
      });
      this.characterByActor.set(actor.guid, actor.guid);
    }
    const moved = this.backend.moveCharacter(actor.guid, translation, dt);
    if (!moved) return;
    // The controller also moves a static body natively: republish it next sync.
    this.staticPoses.delete(actor.guid);
    const localTransform = actorLocalPhysicsTransform(
      moved,
      actor,
      current(),
    );
    actor.transform.position.x = localTransform.position.x;
    actor.transform.position.y = localTransform.position.y;
    actor.transform.position.z = localTransform.position.z;
    actor.transform.rotation.x = localTransform.rotation.x;
    actor.transform.rotation.y = localTransform.rotation.y;
    actor.transform.rotation.z = localTransform.rotation.z;
    actor.transform.rotation.w = localTransform.rotation.w;
  }

  /** Move the component-owned upright capsule; all returned values are world-space. */
  moveMovement(
    actor: Actor,
    translation: Vec3,
    dt: number,
    props: MovementProperties,
  ): { position: Vec3; velocity: Vec3; grounded: boolean } | null {
    if (actor.destroyed || !this.actorFilter(actor) || this.suppressedActors.has(actor) ||
      !this.movementComponent(actor) || !Number.isFinite(dt) || dt <= 0) return null;
    const owner = this.bodyOwnerByActor.get(actor.guid);
    if (owner && owner !== actor) return null;
    // Motors run as `step`'s hook after its pre-step composition and reuse that
    // pass. Once a transition event's script has written a pose through
    // `teleportActor` or `moveCharacter`, later motors resolve their own chain
    // instead, so the write is neither undone nor applied under a stale parent.
    let live: Map<string, Transform> | undefined;
    const transforms = (): ActorTransformMap =>
      this.passStale ? (live ??= this.liveTransforms(actor)) : this.worldTransforms;
    const world = (target: Actor): Transform => transforms().get(target.guid) ?? target.transform;
    if (!this.bodyByActor.has(actor.guid)) this.createForActor(actor, world);
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId) return null;
    const descriptor = [props.radius, props.height, props.maxSlopeAngle, props.groundSnapDistance];
    if (!sameDescriptor(this.movementControllerDescriptors.get(actor.guid), descriptor)) {
      this.backend.createCharacterController({
        id: actor.guid, bodyId, offset: Math.min(0.01, props.radius * 0.1),
        radius: props.radius, height: props.height,
        maxSlopeAngle: props.maxSlopeAngle, groundSnapDistance: props.groundSnapDistance,
      });
      this.characterByActor.set(actor.guid, actor.guid);
      this.movementControllerDescriptors.set(actor.guid, descriptor);
    }
    // Parent transforms are authored repositioning, separate from the motor's
    // displacement and velocity. Native kinematic targets have not stepped yet.
    const startPose = physicsPose(world(actor));
    const moved = this.backend.moveCharacter(actor.guid, translation, dt, startPose);
    if (!moved) return null;
    // Native kinematic targets have not stepped yet: preserve the actor's
    // authored facing instead of overwriting it with last tick's body rotation.
    moved.rotation = startPose.rotation;
    const local = actorLocalPhysicsTransform(moved, actor, transforms());
    Object.assign(actor.transform.position, local.position);
    Object.assign(actor.transform.rotation, local.rotation);
    // Replace the pre-movement target captured at the start of this physics tick.
    this.backend.setBodyTargetTransform(bodyId, moved);
    return { position: moved.position, velocity: moved.velocity, grounded: moved.grounded };
  }

  private movementComponent(actor: Actor): ActorComponent | undefined {
    let movement: ActorComponent | undefined;
    for (const component of actor.components) {
      if (component.destroyed || component.owner !== actor) continue;
      if (["RigidBodyComponent", "WaterBuoyancyComponent", "NavAgentComponent", "RagdollComponent"].includes(component.classId)) return undefined;
      if (component.classId === "MovementComponent") {
        if (movement) return undefined;
        movement = component;
      }
    }
    return movement;
  }

  private rigidComponent(actor: Actor): ActorComponent | undefined {
    const live = (c: ActorComponent) => !c.destroyed && c.owner === actor;
    return actor.components.find((c) => c.classId === "RigidBodyComponent" && live(c))
      ?? (this.backend.kind === "3d" ? actor.components.find((c) => c.classId === "WaterBuoyancyComponent" && live(c)) : undefined);
  }

  /**
   * `world` resolves the actor's current world pose; it runs only after the
   * actor is known to have a body source, so body-less actors compose nothing.
   */
  private createForActor(actor: Actor, world: (actor: Actor) => Transform): void {
    if (this.suppressedActors.has(actor)) return;
    const rigid = this.rigidComponent(actor);
    const movement = this.movementComponent(actor);
    const tilemap = actor.components.find(
      (c) =>
        c.classId === "TilemapComponent" && !c.destroyed && c.owner === actor,
    );
    const blocking = actor.components.find(
      (c) =>
        c.classId === "BlockingVolumeComponent" &&
        !c.destroyed &&
        c.owner === actor,
    );
    if (
      !rigid &&
      !movement &&
      !tilemap &&
      !blocking &&
      this.meshPhysicsComponents(actor).length === 0 &&
      this.landscapePhysicsComponents(actor).length === 0 &&
      this.dynamicMeshPhysicsComponents(actor).length === 0
    )
      return;
    // A hosted actor's solid shapes live on its host; only triggers need a body.
    if (this.hostByActor.has(actor.guid) && !this.hasTriggerCollider(actor)) return;
    const bodyId = `body:${actor.guid}`;
    const props = movement ? MOVEMENT_BODY_PROPERTIES : rigid
      ? this.rigidProps(rigid)
      : parseRigidBodyProperties({
          motionType: "static",
          mass: 0,
          gravityScale: 0,
        });
    const resolved = world(actor);
    const pose = physicsPose(resolved);
    this.backend.createBody({
      id: bodyId,
      actorId: actor.guid,
      motionType: props.motionType,
      mass: props.mass,
      linearDamping: props.linearDamping,
      angularDamping: props.angularDamping,
      gravityScale: props.gravityScale,
      transform: pose,
    });
    try {
      this.applyActorColliders(actor, bodyId, resolved, movement ?? null);
      this.bodyByActor.set(actor.guid, bodyId);
      this.bodyOwnerByActor.set(actor.guid, actor);
      this.appliedBodyProperties.set(actor.guid, {
        component: movement ?? rigid ?? null,
        value: movement || rigid ? props : STATIC_BODY_PROPERTIES,
      });
      // Creation already installed this pose; caching it keeps later syncs
      // from teleporting an unchanged static body every tick.
      if (props.motionType === "static") this.staticPoses.set(actor.guid, physicsPoseDescriptor(pose));
    } catch (error) {
      this.backend.destroyBody(bodyId);
      this.preparedByActor.delete(actor.guid);
      this.tilemapCollidersByActor.delete(actor.guid);
      throw error;
    }
  }

  /**
   * Prepare one complete logical collider set, then publish one native batch.
   * `world` is the actor's resolved world pose: the pre-step pass for per-tick
   * callers, its own current chain for call-time callers. Per-tick callers pass
   * the Movement component they already classified.
   */
  private applyActorColliders(
    actor: Actor,
    bodyId: string,
    world: Transform,
    movement: ActorComponent | null = this.movementComponent(actor) ?? null,
  ): void {
    const hosted = this.hostedShapes(actor, world.scale);
    // A hosted actor's own body keeps only its triggers.
    const triggersOnly = this.hostByActor.has(actor.guid);
    const current = this.actorCollisionDescriptor(actor, movement, world, triggersOnly, hosted);
    const prepared = this.preparedByActor.get(actor.guid);
    if (current.matches(prepared?.actor === actor ? prepared.descriptor : undefined))
      return;
    const descriptor = current.copy();
    const colliders = new Map<string, ColliderDesc>();
    if (movement) {
      const props = parseMovementProperties(Object.fromEntries(movement.variables));
      const id = componentColliderPhysicsId(actor.guid, movement.guid);
      const rotation = uprightCapsuleRotation(world.rotation);
      colliders.set(id, {
        id, bodyId,
        shape: { kind: this.backend.kind === "3d" ? "capsule" : "capsule2d", radius: props.radius, halfHeight: props.height / 2 - props.radius },
        rotation, friction: 0, restitution: 0, isTrigger: false, layer: 1, mask: 0xffffffff,
      });
    }

    if (!movement) {
      this.collectOwnColliders(actor, bodyId, { ...world.scale }, colliders);
      if (triggersOnly)
        for (const [id, collider] of colliders)
          if (!collider.isTrigger) colliders.delete(id);
    }
    if (hosted)
      for (const shape of hosted) this.collectHostedColliders(actor, bodyId, shape, colliders);

    const previous =
      prepared?.actor === actor
        ? prepared.colliders
        : new Map<string, ColliderDesc>();
    const upsert: ColliderDesc[] = [];
    for (const collider of colliders.values()) {
      if (!sameColliderDescriptor(previous.get(collider.id), collider))
        upsert.push(collider);
    }
    const remove = [...previous.keys()].filter((id) => !colliders.has(id));
    if (upsert.length || remove.length)
      this.backend.applyColliderChanges(bodyId, { upsert, remove });
    this.preparedByActor.set(actor.guid, { actor, descriptor, colliders });
  }

  /** Every collider an actor's own components supply, sized by its world `scale`. */
  private collectOwnColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    for (const component of actor.components) {
      if (
        component.classId !== "ColliderComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        continue;
      }
      const collider = this.ordinaryCollider(component);
      const baked = this.geometry(component, "ordinary").prepare(
        collider.shape,
        component.transform,
        scale,
      );
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, {
        id,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation: baked.translation,
        rotation: baked.rotation,
      });
    }

    const blocking = actor.components.find(
      (component) =>
        component.classId === "BlockingVolumeComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (blocking)
      this.collectBlockingVolumeCollider(actor, bodyId, blocking, scale, colliders);
    const tilemap = actor.components.find(
      (component) =>
        component.classId === "TilemapComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (tilemap) {
      const assetGuid = componentAssetGuid(tilemap);
      let prepared = this.tilemapCollidersByActor.get(actor.guid);
      if (prepared?.component !== tilemap || prepared.assetGuid !== assetGuid) {
        const collected = new Map<string, ColliderDesc>();
        this.collectTilemapColliders(actor, bodyId, tilemap, collected);
        prepared = {
          component: tilemap,
          assetGuid,
          colliders: [...collected.values()],
        };
        this.tilemapCollidersByActor.set(actor.guid, prepared);
      }
      for (const collider of prepared.colliders)
        colliders.set(collider.id, collider);
    } else {
      this.tilemapCollidersByActor.delete(actor.guid);
    }
    this.collectSpriteColliders(actor, bodyId, scale, colliders);
    this.collectMeshColliders(actor, bodyId, scale, colliders);
    this.collectLandscapeColliders(actor, bodyId, scale, colliders);
    for (const component of this.dynamicMeshPhysicsComponents(actor)) {
      const shape = this.dynamicMeshCollisions.prepare(component, scale);
      if (!shape) continue;
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, { id, bodyId, shape, friction: 0.5, restitution: 0, isTrigger: false,
        layer: parseMeshCollisionLayer(component.getVariable("layer")), mask: parseMeshCollisionMask(component.getVariable("mask")) });
    }
    // Adding buoyancy alone is enough for a physical float. Authored collision wins.
    const buoyancy = actor.components.find((c) => c.classId === "WaterBuoyancyComponent" && !c.destroyed && c.owner === actor);
    if (this.backend.kind === "3d" && colliders.size === 0 && buoyancy) {
      const props = normalizeWaterBuoyancy(Object.fromEntries(buoyancy.variables));
      const collider = parseColliderProperties({}, "3d");
      const transform = { ...buoyancy.transform, position: { ...buoyancy.transform.position } };
      const offset = rotateVector(transform.rotation, { x: props.offset[0] * transform.scale.x, y: props.offset[1] * transform.scale.y, z: props.offset[2] * transform.scale.z });
      transform.position.x += offset.x; transform.position.y += offset.y; transform.position.z += offset.z;
      const baked = this.geometry(buoyancy, "water").prepare({ kind: "box", halfExtents: { x: props.width / 2, y: props.height / 2, z: props.length / 2 } }, transform, scale);
      const id = componentColliderPhysicsId(actor.guid, buoyancy.guid);
      colliders.set(id, { ...collider, ...baked, id, bodyId });
    }
  }

  private spritePlayback(actor: Actor) {
    return this.spriteClipByActor.get(actor);
  }

  private rigidProps(
    component: ActorComponent,
  ): ReturnType<typeof parseRigidBodyProperties> {
    const current = this.rigidScratch;
    for (let index = 0; index < RIGID_BODY_VARIABLES.length; index++)
      current[index] = component.getVariable(RIGID_BODY_VARIABLES[index]);
    const old = this.rigidProperties.get(component);
    if (old && sameDescriptor(old.descriptor, current)) return old.value;
    const descriptor = current.slice();
    const value = parseRigidBodyProperties(
      Object.fromEntries(
        RIGID_BODY_VARIABLES.map((name, index) => [name, descriptor[index]]),
      ),
    );
    this.rigidProperties.set(component, { descriptor, value });
    return value;
  }

  private ordinaryCollider(
    component: ActorComponent,
  ): ReturnType<typeof parseColliderProperties> {
    const shapeSource = component.getVariable("shape");
    let prepared = this.ordinaryByComponent.get(component);
    if (!prepared || prepared.shapeSource !== shapeSource) {
      prepared = {
        shapeSource,
        shape: parseColliderProperties(
          { shape: shapeSource },
          this.backend.kind,
        ).shape,
      };
      this.ordinaryByComponent.set(component, prepared);
    }
    const tuning = Object.fromEntries(
      ["friction", "restitution", "isTrigger", "layer", "mask"].map((name) => [
        name,
        component.getVariable(name),
      ]),
    );
    return {
      ...parseColliderProperties(tuning, this.backend.kind),
      shape: prepared.shape,
    };
  }

  private geometry(
    component: ActorComponent,
    id: string,
  ): PreparedColliderGeometry {
    let geometries = this.geometryByComponent.get(component);
    if (!geometries) {
      geometries = new Map();
      this.geometryByComponent.set(component, geometries);
    }
    let prepared = geometries.get(id);
    if (!prepared) {
      prepared = new PreparedColliderGeometry();
      geometries.set(id, prepared);
    }
    return prepared;
  }

  /**
   * Written into reusable scratch; the caller copies it only when it changed.
   * A host also covers each hosted child: its pose in the host frame (which
   * ignores the host's world pose) and its collision components.
   */
  private actorCollisionDescriptor(
    actor: Actor,
    movement: ActorComponent | null,
    world: Transform,
    triggersOnly: boolean,
    hosted: readonly HostedShape[] | undefined,
  ): DescriptorScratch {
    const descriptor = this.collisionScratch;
    descriptor.begin();
    descriptor.push(actor);
    if (movement) {
      const rotation = uprightCapsuleRotation(world.rotation);
      // Movement owns a fixed world-sized capsule. Visual frames, authored
      // colliders, local component transforms, and scale cannot change it.
      descriptor.push(movement);
      descriptor.push(movement.getVariable("radius"));
      descriptor.push(movement.getVariable("height"));
      descriptor.push(rotation.x);
      descriptor.push(rotation.y);
      descriptor.push(rotation.z);
      descriptor.push(rotation.w);
    } else {
      const scale = world.scale;
      descriptor.push(actorParentGuid(actor));
      descriptor.push(scale.x);
      descriptor.push(scale.y);
      descriptor.push(scale.z);
      descriptor.push(triggersOnly);
      this.pushComponentDescriptors(descriptor, actor);
    }
    if (hosted)
      for (const { actor: child, relative } of hosted) {
        descriptor.push(child);
        descriptor.pushTransform(relative);
        this.pushComponentDescriptors(descriptor, child);
      }
    return descriptor;
  }

  private pushComponentDescriptors(descriptor: DescriptorScratch, actor: Actor): void {
    for (const component of actor.components) {
      if (!COLLISION_DESCRIPTOR_CLASSES.has(component.classId)) continue;
      descriptor.push(component);
      descriptor.push(component.owner);
      descriptor.push(component.destroyed);
      descriptor.push(component.parentId);
      descriptor.push(componentAssetGuid(component));
      descriptor.pushTransform(component.transform);
      if (component.destroyed) continue;
      if (component.classId === "DynamicRuntimeMeshComponent")
        for (const value of dynamicMeshCollisionDescriptor(component))
          descriptor.push(value);
      for (const name of COLLISION_DESCRIPTOR_VARIABLES)
        descriptor.push(component.getVariable(name));
      if (component.classId === "LandscapeComponent") {
        descriptor.push(component.getVariable("collisionsEnabled"));
        descriptor.push(component.getVariable("depth"));
        descriptor.push(component.getVariable("subdivisions"));
        descriptor.push(component.getVariable("heights"));
      }
      if (component.classId === "MeshComponent") {
        const guid = meshAssetGuid(component);
        descriptor.push(guid ? this.models.get(guid) : null);
        descriptor.push(guid ? this.complexMeshes.get(guid) : null);
      }
      if (component.classId === "TilemapComponent")
        descriptor.push(this.tileInstallation);
      if (component.classId === "SpriteComponent") {
        const playback = this.spritePlayback(actor);
        const frame = resolveSpriteCollisionFrame({
          sprite: this.sprites.get(componentAssetGuid(component) ?? ""),
          animation: playback
            ? this.spriteAnimations.get(playback.assetGuid)
            : undefined,
          playback,
        });
        descriptor.push(this.spriteInstallation);
        descriptor.push(this.pixelsPerUnit);
        descriptor.push(frame?.collision.x);
        descriptor.push(frame?.collision.y);
        descriptor.push(frame?.collision.width);
        descriptor.push(frame?.collision.height);
        descriptor.push(frame?.pivot.x);
        descriptor.push(frame?.pivot.y);
        descriptor.push(frame?.width);
        descriptor.push(frame?.height);
      }
    }
  }

  private landscapePhysicsComponents(actor: Actor): Actor["components"] {
    if (this.backend.kind !== "3d") return [];
    return actor.components.filter((component) => component.classId === "LandscapeComponent" &&
      !component.destroyed && component.owner === actor && component.getVariable("collisionsEnabled") === true);
  }

  private dynamicMeshPhysicsComponents(actor: Actor): ActorComponent[] {
    if (this.backend.kind !== "3d") return [];
    const enabled: ActorComponent[] = [];
    for (const component of actor.components) {
      if (component.classId !== "DynamicRuntimeMeshComponent") continue;
      if (!component.destroyed && component.owner === actor && component.getVariable("enableCollision") === true &&
        dynamicRuntimeGeometry(component)?.indices.length) enabled.push(component);
      else this.dynamicMeshCollisions.remove(component);
    }
    return enabled;
  }

  private collectLandscapeColliders(actor: Actor, bodyId: string, scale: Vec3, colliders: Map<string, ColliderDesc>): void {
    for (const component of this.landscapePhysicsComponents(actor)) {
      const names = ["width", "depth", "subdivisions", "heights", "collisionsEnabled"];
      const descriptor = names.map((name) => component.getVariable(name));
      let source = this.landscapeSources.get(component);
      if (!source || !sameDescriptor(source.descriptor, descriptor)) {
        source = { descriptor, shape: landscapeCollisionMesh(Object.fromEntries(names.map((name, index) => [name, descriptor[index]]))) };
        this.landscapeSources.set(component, source);
      }
      if (!source.shape) continue;
      const baked = this.geometry(component, "landscape").prepare(source.shape, component.transform, scale);
      const id = componentColliderPhysicsId(actor.guid, component.guid);
      colliders.set(id, { id, bodyId, ...baked, friction: 0.5, restitution: 0, isTrigger: false,
        layer: parseMeshCollisionLayer(component.getVariable("layer")), mask: parseMeshCollisionMask(component.getVariable("mask")) });
    }
  }

  private meshPhysicsComponents(actor: Actor): Actor["components"] {
    if (this.backend.kind !== "3d") return [];
    return actor.components.filter((component) => {
      if (
        component.classId !== "MeshComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        return false;
      }
      return this.resolvedMeshCollisions(component).length > 0;
    });
  }

  private resolvedMeshCollisions(
    component: ActorComponent,
  ): ReturnType<typeof resolveMeshCollisions> {
    const assetGuid = meshAssetGuid(component);
    const current = this.meshScratch;
    current[0] = assetGuid;
    current[1] = component.getVariable("collisionMode");
    current[2] = component.getVariable("meshKind");
    current[3] = assetGuid ? this.models.get(assetGuid) : null;
    current[4] = assetGuid ? this.complexMeshes.get(assetGuid) : null;
    const previous = this.meshSources.get(component);
    if (previous && sameDescriptor(previous.descriptor, current))
      return previous.collisions;
    const descriptor = current.slice();
    const collisions = resolveMeshCollisions(
      { assetGuid, collisionMode: descriptor[1], meshKind: descriptor[2] },
      {
        modelPayload: assetGuid ? this.models.get(assetGuid) : undefined,
        complexMesh: assetGuid ? this.complexMeshes.get(assetGuid) : undefined,
      },
    );
    this.meshSources.set(component, { descriptor, collisions });
    this.geometryByComponent.delete(component);
    if (assetGuid && descriptor[4] == null && parseMeshCollisionMode(descriptor[1]) === "complex")
      this.onMissingComplexMesh?.(assetGuid);
    return collisions;
  }

  private collectMeshColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    for (const component of this.meshPhysicsComponents(actor)) {
      const layer = parseMeshCollisionLayer(component.getVariable("layer"));
      const mask = parseMeshCollisionMask(component.getVariable("mask"));
      for (const collision of this.resolvedMeshCollisions(component)) {
        const colliderId = componentColliderPhysicsId(
          actor.guid,
          component.guid,
          collision.shapeId,
        );
        const baked = this.geometry(
          component,
          collision.shapeId,
        ).prepareImported(
          collision.shape as ColliderShape,
          {
            position: {
              x: collision.position[0],
              y: collision.position[1],
              z: collision.position[2],
            },
            rotation: {
              x: collision.rotation[0],
              y: collision.rotation[1],
              z: collision.rotation[2],
              w: collision.rotation[3],
            },
            scale: {
              x: collision.scale[0],
              y: collision.scale[1],
              z: collision.scale[2],
            },
          },
          component.transform,
          scale,
        );
        colliders.set(colliderId, {
          id: colliderId,
          bodyId,
          shape: baked.shape,
          friction: 0.5,
          restitution: 0,
          isTrigger: false,
          layer,
          mask,
          translation: baked.translation,
          rotation: baked.rotation,
        });
      }
    }
  }

  private collectBlockingVolumeCollider(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const hx = Math.max(Math.abs(scale.x) / 2, 0.05);
    const hy = Math.max(Math.abs(scale.y) / 2, 0.05);
    const hz = Math.max(Math.abs(scale.z) / 2, 0.05);
    const id = componentColliderPhysicsId(actor.guid, component.guid);
    colliders.set(id, {
      id,
      bodyId,
      shape:
        this.backend.kind === "2d"
          ? { kind: "box2d", halfExtents: { x: hx, y: hy } }
          : { kind: "box", halfExtents: { x: hx, y: hy, z: hz } },
      friction: 0.5,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 0xffffffff,
    });
  }

  private collectSpriteColliders(
    actor: Actor,
    bodyId: string,
    scale: Vec3,
    colliders: Map<string, ColliderDesc>,
  ): void {
    const sprite = actor.components.find(
      (component) =>
        component.classId === "SpriteComponent" &&
        !component.destroyed &&
        component.owner === actor,
    );
    if (!sprite) return;
    const spriteGuid =
      sprite.assetGuid ??
      (typeof sprite.getVariable("assetGuid") === "string"
        ? String(sprite.getVariable("assetGuid"))
        : "");
    const spritePayload = spriteGuid ? this.sprites.get(spriteGuid) : undefined;
    const playback = this.spritePlayback(actor);
    const frame = resolveSpriteCollisionFrame({
      sprite: spritePayload,
      animation: playback
        ? this.spriteAnimations.get(playback.assetGuid)
        : undefined,
      playback,
    });
    if (!frame) return;
    const ppu =
      (spritePayload?.pixelsPerUnit && spritePayload.pixelsPerUnit > 0
        ? spritePayload.pixelsPerUnit
        : this.pixelsPerUnit) || 100;
    const mapped = spriteCollisionToBox2d({
      collision: frame.collision,
      pivot: frame.pivot,
      pixelWidth: frame.width ?? 100,
      pixelHeight: frame.height ?? 100,
      pixelsPerUnit: ppu,
    });
    for (const component of actor.components) {
      if (
        component.classId !== "ColliderComponent" ||
        component.destroyed ||
        component.owner !== actor
      ) {
        continue;
      }
      const collider = this.ordinaryCollider(component);
      if (collider.shape.kind !== "box2d") continue;
      const colliderId = componentColliderPhysicsId(actor.guid, component.guid);
      const baked = bakeColliderLocal(
        { kind: "box2d", halfExtents: mapped.halfExtents },
        {
          position: {
            x: component.transform.position.x + mapped.translation.x,
            y: component.transform.position.y + mapped.translation.y,
            z: component.transform.position.z,
          },
          rotation: component.transform.rotation,
          scale: component.transform.scale,
        },
        scale,
      );
      colliders.set(colliderId, {
        id: colliderId,
        bodyId,
        shape: baked.shape,
        friction: collider.friction,
        restitution: collider.restitution,
        isTrigger: collider.isTrigger,
        layer: collider.layer,
        mask: collider.mask,
        translation: baked.translation,
        rotation: baked.rotation,
      });
    }
  }

  private collectTilemapColliders(
    actor: Actor,
    bodyId: string,
    component: Actor["components"][number],
    colliders: Map<string, ColliderDesc>,
  ): void {
    const guid =
      component.assetGuid ??
      (typeof component.getVariable("assetGuid") === "string"
        ? String(component.getVariable("assetGuid"))
        : null);
    if (!guid) return;
    const tilemap = this.tilemaps.get(guid);
    if (!tilemap || tilemapTilesetGuids(tilemap).length === 0) return;
    const ppu = this.pixelsPerUnit > 0 ? this.pixelsPerUnit : 100;
    const worldTileWidth = tilemap.tileWidth / ppu;
    const worldTileHeight = tilemap.tileHeight / ppu;
    const resolveGid = (gid: number) => {
      return decodeTileGid(tilemap, gid, this.tilesets);
    };
    const fallback =
      this.tilesets.get(tilemapTilesetGuids(tilemap)[0] ?? "") ??
      this.tilesets.values().next().value;
    if (!fallback) return;
    let index = 0;
    for (const layer of tilemap.layers) {
      if (!layer.collision) continue;
      for (const chunk of layer.chunks) {
        const chains = tilemapChunkChains({
          tiles: chunk.tiles,
          chunkSize: tilemap.chunkSize,
          chunkX: chunk.cx,
          chunkY: chunk.cy,
          tileset: fallback,
          worldTileWidth,
          worldTileHeight,
          resolveGid,
        });
        for (const chain of chains) {
          if (chain.points.length < 2) continue;
          const id = `tilemap:${actor.guid}:${layer.id}:${chunk.cx}:${chunk.cy}:${index}`;
          colliders.set(id, {
            id,
            bodyId,
            shape: { kind: "chain", points: chain.points, loop: chain.loop },
            friction: 0.5,
            restitution: 0,
            isTrigger: false,
            layer: 1,
            mask: 0xffffffff,
          });
          index += 1;
        }
      }
    }
  }
}

/** How an actor's body moves, for choosing the host of its static descendants. */
type BodyMotion = "simulated" | "static" | "none";

/** A hosted child and its pose (with composed scale) in its host's body frame. */
type HostedShape = { actor: Actor; relative: Transform };

function unitQuaternion(rotation: Transform["rotation"]): Transform["rotation"] {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (length === 0 || !Number.isFinite(length)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: rotation.x / length, y: rotation.y / length, z: rotation.z / length, w: rotation.w / length };
}

/** A resolved world pose as a native body pose; scale stays with colliders. */
function physicsPose(world: Transform): PhysicsTransform {
  return {
    position: { ...world.position },
    rotation: { ...world.rotation },
  };
}

export function actorLocalPhysicsTransform(
  world: PhysicsTransform,
  actor: Actor,
  transforms: ActorTransformMap,
): PhysicsTransform {
  const parentId = actorParentGuid(actor);
  const parentWorld = parentId ? transforms.get(parentId) : undefined;
  return parentWorld ? localPhysicsTransform(world, parentWorld, actor.transform) : world;
}

/**
 * A body's world pose as the actor's local position and rotation. The actor
 * keeps its own scale, so its composed world scale completes the body pose,
 * and a nonuniform or mirrored parent inverts through the authored matrices.
 */
function localPhysicsTransform(
  world: PhysicsTransform,
  parentWorld: Transform,
  local: Transform,
): PhysicsTransform {
  const { x: sx, y: sy, z: sz } = parentWorld.scale;
  if (!(sx === sy && sy === sz)) {
    const relative = relativeTransform(parentWorld, {
      position: world.position,
      rotation: world.rotation,
      scale: composeParentChildTransform(parentWorld, local).scale,
    }, local);
    if (relative) return { position: relative.position, rotation: relative.rotation };
  }
  const inverseRotation = inverseQuaternion(parentWorld.rotation);
  const offset = rotateVector(inverseRotation, {
    x: world.position.x - parentWorld.position.x,
    y: world.position.y - parentWorld.position.y,
    z: world.position.z - parentWorld.position.z,
  });
  return {
    position: {
      x: divideScale(offset.x, parentWorld.scale.x),
      y: divideScale(offset.y, parentWorld.scale.y),
      z: divideScale(offset.z, parentWorld.scale.z),
    },
    rotation: multiplyQuaternion(inverseRotation, world.rotation),
  };
}

function resolveSpriteCollisionFrame(options: {
  sprite: SpritePayload | undefined;
  animation: SpriteAnimationPayload | undefined;
  playback:
    { assetGuid: string; clipName: string; normalisedTime: number } | undefined;
}): {
  collision: { x: number; y: number; width: number; height: number };
  pivot: { x: number; y: number };
  width?: number;
  height?: number;
} | null {
  if (options.animation && options.playback) {
    const frame = spriteAnimationFrameAt(
      options.animation,
      options.playback.normalisedTime,
    );
    if (frame) {
      return {
        collision: frame.collision,
        pivot: frame.pivot,
        width: frame.width,
        height: frame.height,
      };
    }
  }
  if (!options.sprite) return null;
  if (options.playback?.clipName) {
    const clipFrame = spriteClipFrameAt(
      options.sprite,
      options.playback.clipName,
      options.playback.normalisedTime,
    );
    if (clipFrame) {
      return {
        collision: clipFrame.collision ?? { x: 0, y: 0, width: 1, height: 1 },
        pivot: clipFrame.pivot,
        width: clipFrame.width,
        height: clipFrame.height,
      };
    }
  }
  const fallback = options.sprite.frames[0];
  if (!fallback) return null;
  return {
    collision: fallback.collision ?? { x: 0, y: 0, width: 1, height: 1 },
    pivot: fallback.pivot,
    width: fallback.width,
    height: fallback.height,
  };
}

function divideScale(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
}

function componentAssetGuid(component: ActorComponent): string | null {
  const value = component.assetGuid ?? component.getVariable("assetGuid");
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  if (value instanceof Map) return new Map(value);
  return new Map(Object.entries(value));
}

function sameColliderDescriptor(
  a: ColliderDesc | undefined,
  b: ColliderDesc,
): boolean {
  return (
    !!a &&
    a.shape === b.shape &&
    a.friction === b.friction &&
    a.restitution === b.restitution &&
    a.isTrigger === b.isTrigger &&
    a.layer === b.layer &&
    a.mask === b.mask &&
    a.translation?.x === b.translation?.x &&
    a.translation?.y === b.translation?.y &&
    a.translation?.z === b.translation?.z &&
    a.rotation?.x === b.rotation?.x &&
    a.rotation?.y === b.rotation?.y &&
    a.rotation?.z === b.rotation?.z &&
    a.rotation?.w === b.rotation?.w
  );
}

/** Installation owns immutable collision content; each call is a new source generation. */
function ownedContentMap<T>(
  value: ReadonlyMap<string, T> | Readonly<Record<string, T>>,
): Map<string, T> {
  return new Map(
    [...toMap(value)].map(([guid, content]) => [
      guid,
      structuredClone(content),
    ]),
  );
}

const RIGID_BODY_VARIABLES = [
  "motionType",
  "mass",
  "linearDamping",
  "angularDamping",
  "gravityScale",
] as const;

/** Components whose inspector edits rebuild their owner's colliders. */
const COLLIDER_REFRESH_CLASSES = new Set([
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "LandscapeComponent",
  "ColliderComponent",
  "SpriteComponent",
  "TilemapComponent",
  "BlockingVolumeComponent",
]);

const COLLISION_DESCRIPTOR_CLASSES = new Set([
  "ColliderComponent",
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "LandscapeComponent",
  "SpriteComponent",
  "TilemapComponent",
  "BlockingVolumeComponent",
  "WaterBuoyancyComponent",
  "MovementComponent",
]);

const COLLISION_DESCRIPTOR_VARIABLES = [
  "shape",
  "friction",
  "restitution",
  "isTrigger",
  "layer",
  "mask",
  "collisionMode",
  "meshKind",
  "assetGuid",
  "width",
  "length",
  "height",
  "offset",
  "radius",
] as const;

/**
 * Variable-length descriptor written in place each tick. Its backing array is
 * never stored: callers keep `copy()` only when `matches()` reports a change.
 */
class DescriptorScratch {
  private readonly values: unknown[] = [];
  private written = 0;
  private length = 0;

  begin(): void {
    this.length = 0;
  }

  push(value: unknown): void {
    this.values[this.length++] = value;
  }

  pushTransform(local: ColliderLocalTransform): void {
    this.push(local.position.x);
    this.push(local.position.y);
    this.push(local.position.z);
    this.push(local.rotation.x);
    this.push(local.rotation.y);
    this.push(local.rotation.z);
    this.push(local.rotation.w);
    this.push(local.scale.x);
    this.push(local.scale.y);
    this.push(local.scale.z);
  }

  matches(stored: readonly unknown[] | undefined): boolean {
    // Release references left by a longer previous descriptor.
    if (this.written > this.length) this.values.fill(undefined, this.length, this.written);
    this.written = this.length;
    if (!stored || stored.length !== this.length) return false;
    for (let index = 0; index < this.length; index++)
      if (!Object.is(stored[index], this.values[index])) return false;
    return true;
  }

  copy(): unknown[] {
    return this.values.slice(0, this.length);
  }
}

const STATIC_BODY_PROPERTIES = parseRigidBodyProperties({
  motionType: "static",
  mass: 0,
  gravityScale: 0,
});

const MOVEMENT_BODY_PROPERTIES = parseRigidBodyProperties({
  motionType: "kinematic", mass: 1, gravityScale: 0, linearDamping: 0, angularDamping: 0,
});

/** An upright capsule needs an axis correction, never a twist around that axis. */
function uprightCapsuleRotation(rotation: PhysicsTransform["rotation"]): PhysicsTransform["rotation"] {
  const up = rotateVector(inverseQuaternion(rotation), { x: 0, y: 1, z: 0 });
  const length = Math.hypot(up.x, up.y, up.z);
  if (length === 0) return { x: 0, y: 0, z: 0, w: 1 };
  const x = up.z / length, z = -up.x / length, w = 1 + up.y / length;
  const norm = Math.hypot(x, z, w);
  if (norm < 1e-8) return { x: 1, y: 0, z: 0, w: 0 };
  return { x: x === 0 ? 0 : x / norm, y: 0, z: z === 0 ? 0 : z / norm, w: w / norm };
}

function physicsPoseDescriptor(pose: PhysicsTransform): readonly number[] {
  return [pose.position.x, pose.position.y, pose.position.z,
    pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w];
}

function meshAssetGuid(component: ActorComponent): string | null {
  const variable = component.getVariable("assetGuid");
  if (typeof variable === "string") return variable.trim() || null;
  return component.assetGuid;
}
