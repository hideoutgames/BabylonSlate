import { WaterWorld } from "./water-world";
import type { CollisionFilter, CollisionPreset, MovementProperties, Transform } from "@haptic/core";
import {
  multiplyQuat,
  parseRigidBodyProperties,
  rotateQuatVec,
  type LineTraceOptions,
  type PhysicsBackend,
  type PhysicsTransform,
  type Vec3,
  type TeleportOptions,
} from "@haptic/physics";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import {
  PhysicsCompositionScratch,
  sameDescriptor,
  physicsChainTransforms,
  physicsParticipantActors,
  physicsWorldTransforms,
} from "./physics-preparation";
import { PhysicsConstraintSync } from "./physics-constraint-sync";
import type { ActorTransformMap } from "./actor-world-transform";
import {
  MOVEMENT_BODY_PROPERTIES,
  PhysicsBodyClassifier,
  STATIC_BODY_PROPERTIES,
  hasTriggerCollider,
  type MovementDrive,
} from "./physics-body-classification";
import { COLLIDER_REFRESH_CLASSES, PhysicsColliderSets } from "./physics-collider-sets";
import { PhysicsHosting, unitQuaternion, type BodyMotion } from "./physics-hosting";
import type { ModelContent } from "./physics-mesh-colliders";
import { PhysicsQueryChannels } from "./physics-query-channels";
import { PhysicsReadback, actorLocalPhysicsTransform } from "./physics-readback";
import type { SpriteClipPlayback, SpriteContent, TileContent } from "./physics-sprite-tile-colliders";

export { actorLocalPhysicsTransform } from "./physics-readback";
export type { MovementDrive } from "./physics-body-classification";

/**
 * Keeps `@haptic/physics` bodies in sync with World actors that carry
 * RigidBodyComponent / ColliderComponent, MeshComponent collision, tilemap
 * collision, enabled Landscapes, or a Blocking Volume.
 */
export class PhysicsWorldSync {
  readonly water = new WaterWorld((actors) => actors === this.actors ? this.world : null);
  private readonly backend: PhysicsBackend;
  private readonly actorFilter: (actor: Actor) => boolean;
  private readonly skipEmptySteps: boolean;
  private readonly actorsOf: ((world: World) => readonly Actor[]) | undefined;
  private readonly observesContacts: ((actor: Actor) => boolean) | undefined;
  /** Contact reporting last asked of the backend per actor guid; absent means the default, reporting. */
  private readonly contactReporting = new Map<string, boolean>();
  private readonly constraints: PhysicsConstraintSync;
  private readonly suppressedActors = new WeakSet<Actor>();
  /**
   * Actors whose ordinary body an active ragdoll replaced, by guid. The bones are dynamic bodies the ragdoll
   * created under the actor's id, so they appear in no body map; channel queries classify them from here.
   */
  private readonly ragdollActors = new Map<string, Actor>();
  private readonly bodyByActor = new Map<string, string>();
  private readonly characterByActor = new Map<string, string>();
  private readonly movementControllerDescriptors = new Map<string, readonly unknown[]>();
  private readonly bodyOwnerByActor = new Map<string, Actor>();
  private readonly appliedBodyProperties = new Map<
    string,
    {
      component: ActorComponent | null;
      value: ReturnType<typeof parseRigidBodyProperties>;
      /** Movement steers this dynamic body, so it stays upright. */
      lockRotation: boolean;
    }
  >();
  private readonly staticPoses = new Map<string, readonly unknown[]>();
  // Per-tick scratch. Descriptors are compared in place and copied only when
  // they change, so a stored descriptor is never a scratch array.
  private readonly passSources = new Map<Actor, ActorComponent | null>();
  private readonly liveActors = new Set<string>();
  private readonly poseScratch: unknown[] = [];
  /** Reused by every pre-step composition; readback recomposes into its own. */
  private readonly composition = new PhysicsCompositionScratch();
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
  // Built once in the constructor, after the options their hosts read.
  private readonly colliders: PhysicsColliderSets;
  private readonly classifier: PhysicsBodyClassifier;
  private readonly hosting: PhysicsHosting;
  private readonly readback: PhysicsReadback;
  private readonly channels: PhysicsQueryChannels;

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
      /**
       * The actors this world can simulate, in World order, read afresh at each use. Omitted: the World's actors
       * that own a physics component class. `actorFilter` still decides eligibility; this only spares a world that
       * admits few actors (a Scene Layer's) from walking the rest of the World each tick.
       */
      actorsOf?: (world: World) => readonly Actor[];
      /**
       * Whether a hit or overlap event naming `actor` could be observed (a script handler on its class). Bodies of
       * actors that cannot observe any, and host no shape of one that can, are not asked for native contact
       * events (`PhysicsBackend.setContactReporting`). Omitted: every actor is observed.
       */
      observesContacts?: (actor: Actor) => boolean;
      /**
       * The project Collision Presets (`PhysicsProjectSettings.collisionPresets`). A collider whose `collisionPreset`
       * names one takes its layer and mask. Omitted: every collider keeps its own.
       */
      collisionPresets?: readonly Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask">[];
    },
  ) {
    this.backend = backend;
    this.observesContacts = options?.observesContacts;
    this.skipEmptySteps = options?.skipEmptySteps ?? false;
    this.actorsOf = options?.actorsOf;
    this.actorFilter = options?.actorFilter ?? (() => true);
    this.colliders = new PhysicsColliderSets(backend, options?.collisionPresets);
    this.classifier = new PhysicsBodyClassifier(backend.kind, this.colliders.meshes);
    // Hosts read reassigned state (`actors`, `world`, `worldTransforms`, the
    // hosting map) through closures, never as captured values.
    this.hosting = new PhysicsHosting({
      findLiveActor: this.findLiveActor,
      actorCount: () => this.actors.length,
      isStaticSource: (source) => this.classifier.isStaticSource(source),
      hasSolidCollision: (actor) => this.classifier.hasSolidCollision(actor),
    });
    this.readback = new PhysicsReadback({
      backend,
      bodies: this.bodyByActor,
      bodyOwners: this.bodyOwnerByActor,
      eligible: this.actorFilter,
      findLiveActor: this.findLiveActor,
      isStaticBody: (actorId) => this.isStaticBody(actorId),
      candidateActors: () => this.candidateActors(),
      passTransforms: () => this.worldTransforms,
    });
    this.channels = new PhysicsQueryChannels({
      structuralRevision: () => this.world?.structuralRevision ?? 0,
      motionOf: (actorId) => this.appliedBodyProperties.get(actorId)?.value.motionType,
      movementDrive: (actor) => this.classifier.movementDrive(actor),
      bodyOwners: this.bodyOwnerByActor,
      hosts: () => this.hosting.hosts,
      ragdollActors: this.ragdollActors,
    });
    this.constraints = new PhysicsConstraintSync(backend, options?.deferUnsupportedConstraints);
  }

  getBackend(): PhysicsBackend {
    return this.backend;
  }

  /** A collider's layer and responses in this world: its Collision Preset's, or its own when Custom. */
  collisionFilter(own: CollisionFilter, presetRef: unknown): CollisionFilter {
    return this.colliders.collisionFilter(own, presetRef);
  }

  /** Capture native center-of-mass motion before replacing the actor's body. */
  getActorVelocity(actor: Actor) {
    if (this.bodyOwnerByActor.get(actor.guid) !== actor) return null;
    const bodyId = this.bodyByActor.get(actor.guid);
    return bodyId ? this.backend.getBodyVelocity(bodyId) : null;
  }

  /**
   * Whether native contact events should be requested for `actor`'s bodies: an observer exists for the actor or
   * for a static child whose solid shapes this actor's compound hosts, since the host's body raises their contacts.
   */
  private wantsContacts(actor: Actor): boolean {
    const observes = this.observesContacts;
    if (!observes || observes(actor)) return true;
    const hosted = this.hosting.hostedChildren(actor.guid);
    if (hosted) for (const child of hosted) if (observes(child)) return true;
    return false;
  }

  /** `wantsContacts`, recorded as what is being asked of the backend for the bodies the caller is about to create. */
  claimContactReporting(actor: Actor): boolean {
    const wants = this.wantsContacts(actor);
    if (wants) this.contactReporting.delete(actor.guid);
    else this.contactReporting.set(actor.guid, false);
    return wants;
  }

  /** Bring the backend's contact reporting for `actor` in line with `wantsContacts`; cheap when unchanged. */
  refreshContactReporting(actor: Actor): void {
    if (!this.observesContacts || !this.backend.setContactReporting) return;
    const wants = this.wantsContacts(actor);
    if ((this.contactReporting.get(actor.guid) ?? true) === wants) return;
    this.contactReporting.set(actor.guid, wants);
    this.backend.setContactReporting(actor.guid, wants);
  }

  /** An articulated ragdoll replaces the actor's ordinary body and colliders. */
  suppressActorBody(actor: Actor, suppressed: boolean): void {
    this.invalidateChannels();
    if (suppressed) {
      this.suppressedActors.add(actor);
      this.ragdollActors.set(actor.guid, actor);
      if (this.bodyOwnerByActor.get(actor.guid) === actor) this.retireActor(actor.guid);
    } else {
      this.suppressedActors.delete(actor);
      if (this.ragdollActors.get(actor.guid) === actor) this.ragdollActors.delete(actor.guid);
      this.contactReporting.delete(actor.guid);
    }
  }

  setTileContent(options: TileContent): void {
    this.colliders.tiles.setTileContent(options);
  }

  setSpriteContent(options: SpriteContent): void {
    this.colliders.tiles.setSpriteContent(options);
  }

  setModelContent(options: ModelContent): void {
    this.colliders.meshes.setModelContent(options);
  }

  /**
   * Called (once per resolution) when a Complex Collision MeshComponent names a
   * Model with no installed mesh, so the host can cook it on demand. The
   * component contributes no collider until the mesh is installed; the next
   * sync then rebuilds the actor's body.
   */
  setMissingComplexMeshHandler(handler: ((assetGuid: string) => void) | null): void {
    this.colliders.meshes.setMissingComplexMeshHandler(handler);
  }

  setActorSpriteClip(actor: Actor, clip: SpriteClipPlayback | null): void {
    this.colliders.tiles.setActorSpriteClip(actor, clip);
  }

  dispose(): void {
    this.constraints.dispose();
    this.backend.dispose();
    this.bodyByActor.clear();
    this.characterByActor.clear();
    this.movementControllerDescriptors.clear();
    this.bodyOwnerByActor.clear();
    this.ragdollActors.clear();
    this.invalidateChannels();
    this.channels.clearCache();
    this.contactReporting.clear();
    this.staticPoses.clear();
    this.hosting.clear();
    this.passSources.clear();
    this.liveActors.clear();
    this.readback.clear();
    this.appliedBodyProperties.clear();
    this.colliders.clear();
    this.actors = [];
    this.world = null;
    this.worldTransforms = new Map();
    this.passStale = false;
  }

  /** Ensure every physics-bearing actor has backend bodies (idempotent). */
  syncFromWorld(world: World): void {
    this.bindWorld(world);
    const candidates = this.candidateActors();
    this.worldTransforms = physicsWorldTransforms(
      candidates,
      this.findLiveActor,
      this.backend.kind,
      this.actorFilter,
      undefined,
      this.composition,
    );
    this.passStale = false;
    const sources = this.passSources;
    sources.clear();
    for (const actor of candidates) {
      if (actor.destroyed) continue;
      if (!this.actorFilter(actor) || this.suppressedActors.has(actor)) continue;
      const source = this.classifier.classify(actor);
      if (source !== false) sources.set(actor, source);
    }
    // Hosts are known before any body changes, so a compound and the bodies
    // its children leave or regain are reconciled in the same pass.
    if (this.hosting.assign(sources)) this.invalidateChannels();
    const live = this.liveActors;
    live.clear();
    for (const [actor, source] of sources) {
      // A hosted actor keeps a body of its own only for its trigger colliders.
      if (this.hosting.isHosted(actor.guid) && !hasTriggerCollider(actor)) continue;
      live.add(actor.guid);
      this.reconcileActor(actor, source, this.passWorldTransform);
      // After hosting settled, so a host reports the contacts of the children it hosts.
      if (this.bodyByActor.has(actor.guid)) this.refreshContactReporting(actor);
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
        : this.classifier.classify(actor);
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
    // A Movement source is a kinematic capsule or a dynamic Rigid Body Movement steers; buoyancy and Nav Agent never coexist with it.
    const movement = source?.classId === "MovementComponent" ? source : null;
    const drive = movement ? this.classifier.movementDrive(actor) : undefined;
    const steered = drive?.dynamic === true;
    const rigid = movement ? (steered ? this.classifier.rigidComponent(actor) ?? null : null) : source;
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
      if (movement && !steered) {
        this.applyBodyPolicy(actor.guid, bodyId, movement, MOVEMENT_BODY_PROPERTIES);
        this.backend.setBodyTargetTransform(bodyId, physicsPose(pose));
      } else if (rigid) {
        const props = this.classifier.rigidProps(rigid);
        this.applyBodyPolicy(actor.guid, bodyId, rigid, props, steered);
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
      this.applyActorColliders(actor, bodyId, pose, drive ?? null);
    }
    if ((!movement || steered) && this.movementControllerDescriptors.has(actor.guid)) {
      this.backend.destroyCharacterController(actor.guid);
      this.characterByActor.delete(actor.guid);
      this.movementControllerDescriptors.delete(actor.guid);
    }
    return created;
  }

  /**
   * Call-time hosting of one actor from its current chain. Leaving a host
   * rebuilds that host's compound now; callers rebuild the new host.
   */
  private refreshLiveHost(actor: Actor, source: ActorComponent | null | false): Actor | null {
    const host =
      source !== false && this.classifier.isStaticSource(source) && this.classifier.hasSolidCollision(actor)
        ? this.hosting.simulatedAncestor(actor, this.liveMotion, this.findLiveActor)
        : null;
    const previous = this.hosting.hostOf(actor.guid);
    if (previous === host) return host;
    this.invalidateChannels();
    this.hosting.move(actor, previous, host);
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
    if (hasTriggerCollider(actor)) return false;
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
    const source = this.classifier.classify(actor);
    return source === false ? "none" : this.classifier.isStaticSource(source) ? "static" : "simulated";
  };

  private bindWorld(world: World): void {
    // A different World counts structure revisions of its own.
    if (this.world !== world) this.invalidateChannels();
    this.world = world;
    this.actors = world.getActors();
  }

  /**
   * The actors a pass walks to find bodies, in World order: those `actorsOf` names, else the World's actors that
   * own a physics component class. Parent walks and water keep `actors`, the whole World, since a chain may leave
   * the subset.
   */
  private candidateActors(): readonly Actor[] {
    if (!this.world) return this.actors;
    return this.actorsOf ? this.actorsOf(this.world) : physicsParticipantActors(this.world);
  }

  /**
   * The live actor holding `guid`: the World's own registry, which lists exactly the actors `World.getActors()`
   * does (a spawn or destroy updates both together). None before a world is bound.
   */
  private readonly findLiveActor = (guid: string): Actor | undefined => this.world?.findActor(guid);

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

  private syncConstraints(worldScale: (actor: Actor) => Vec3): void {
    this.constraints.sync({
      world: this.world,
      findActor: this.findLiveActor,
      worldScale,
      bodies: this.bodyByActor,
      bodyOwners: this.bodyOwnerByActor,
      eligible: this.actorFilter,
      // A hosted actor's joints attach where its shapes are: on its host's body.
      hosting: {
        hostOf: (actor) => this.hosting.hostOf(actor.guid),
        frame: (actor, host) => {
          const relative = this.hosting.relativeTransform(host, worldScale(host), actor);
          return relative && { ...relative, rotation: unitQuaternion(relative.rotation) };
        },
      },
    });
  }

  /**
   * Call-time joint reconciliation. Targets are found through a guid index of
   * the world and owners through the component owner index, and only connected
   * endpoints compose their own ancestor chains for anchor scale, instead of
   * every physics participant.
   */
  private syncLiveConstraints(): void {
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
    lockRotation = false,
  ): void {
    const applied = this.appliedBodyProperties.get(actorId);
    if (applied?.component === component && applied.value === value && applied.lockRotation === lockRotation) return;
    // Static and Dynamic follow the motion type; other tuning does not reach a channel.
    if (applied?.value.motionType !== value.motionType) this.invalidateChannels();
    // The lock is sent only when it changes (creation set the initial one).
    this.backend.updateBody(bodyId, lockRotation === (applied?.lockRotation ?? false) ? value : { ...value, lockRotation });
    this.appliedBodyProperties.set(actorId, { component, value, lockRotation });
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

  private retireActor(actorId: string): void {
    this.invalidateChannels();
    const bodyId = this.bodyByActor.get(actorId);
    if (bodyId) {
      this.constraints.retireBody(bodyId);
      this.backend.destroyBody(bodyId);
    }
    this.bodyByActor.delete(actorId);
    const owner = this.bodyOwnerByActor.get(actorId);
    this.bodyOwnerByActor.delete(actorId);
    this.contactReporting.delete(actorId);
    this.staticPoses.delete(actorId);
    this.appliedBodyProperties.delete(actorId);
    this.characterByActor.delete(actorId);
    this.movementControllerDescriptors.delete(actorId);
    this.colliders.forgetActor(actorId, owner);
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
        // The body's own actor: a step hook may have replaced the guid's holder.
        const actor = this.bodyOwnerByActor.get(actorId);
        const tuning = this.appliedBodyProperties.get(actorId)?.value;
        if (actor && tuning?.motionType === "dynamic")
          this.water.applyBuoyancy(actor, bodyId, this.backend, tuning.mass, gravity, dt);
      }
    }
    this.backend.step(dt);
    this.readback.readBack(recompose);
  }

  /** The bodies, hosting, motion types or ragdolls behind the channels' ignore lists changed. */
  private invalidateChannels(): void {
    this.channels.invalidate();
  }

  /** How many times a channel's ignore list was built, so a test can tell a reused list from a rebuilt one. */
  get channelListBuilds(): number {
    return this.channels.builds;
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions & { channel?: string }) {
    return this.backend.lineTrace(start, end, this.channels.options(options));
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions & { channel?: string }) {
    return this.backend.sphereOverlap(center, radius, this.channels.options(options));
  }

  shapeSweep(
    shape: Parameters<PhysicsBackend["shapeSweep"]>[0],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions & { channel?: string },
  ) {
    return this.backend.shapeSweep(shape, start, end, this.channels.options(options));
  }

  addImpulse(actorId: string, impulse: Vec3, strength?: number): void {
    const bodyId = this.bodyByActor.get(actorId);
    // Dropped like an impulse at a point, so a non-finite input cannot corrupt the body's velocity and pose.
    // A 2D impulse may omit z.
    const vector = { x: impulse?.x, y: impulse?.y, z: impulse?.z ?? 0 };
    if (!bodyId || ![vector.x, vector.y, vector.z, strength ?? 1].every(Number.isFinite)) return;
    this.backend.addImpulse(bodyId, vector as Vec3, strength);
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
    const host = this.refreshLiveHost(actor, this.suppressedActors.has(actor) ? false : this.classifier.classify(actor));
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
    if (this.isStaticBody(actor.guid)) {
      this.syncStaticPose(actor, bodyId, pose);
      return;
    }
    this.backend.teleportBody(bodyId, physicsPose(pose), options);
    // A kinematic body (including Movement) may hold this tick's pre-step
    // target, which the next step would otherwise move it back to.
    if (this.appliedBodyProperties.get(actor.guid)?.value.motionType === "kinematic")
      this.backend.setBodyTargetTransform(bodyId, physicsPose(pose));
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
    const host = this.hosting.hostOf(owner.guid);
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
      const drive = this.classifier.movementDrive(owner);
      // Movement's kinematic capsule ignores these knobs; the next step reconciles a changed Motion Type.
      if (drive && !drive.dynamic) return;
      const props = this.classifier.rigidProps(component);
      this.applyBodyPolicy(owner.guid, bodyId, component, props, drive?.dynamic === true);
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
   * The solve starts from the actor's composed pose at call time, as Movement's
   * does, and converts back against the parent's pose at call time: scripts,
   * readback and navigation may have moved either since the last pre-step pass.
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
    const startPose = physicsPose(current().get(actor.guid)!);
    const moved = this.backend.moveCharacter(actor.guid, translation, dt, startPose);
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
      this.classifier.movementDrive(actor)?.dynamic !== false || !Number.isFinite(dt) || dt <= 0) return null;
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
    // The backend keeps the authored facing and replaces the pre-movement
    // target captured at the start of this physics tick.
    const startPose = physicsPose(world(actor));
    const moved = this.backend.moveCharacter(actor.guid, translation, dt, startPose);
    if (!moved) return null;
    const local = actorLocalPhysicsTransform(moved, actor, transforms());
    Object.assign(actor.transform.position, local.position);
    Object.assign(actor.transform.rotation, local.rotation);
    return { position: moved.position, velocity: moved.velocity, grounded: moved.grounded };
  }

  /**
   * Physics-driven Movement: the steered body's linear velocity and the normal
   * of the walkable ground under it (null in the air), as the last step left
   * them. Null when Movement cannot steer this actor. A body not created yet
   * reads as still and airborne.
   */
  movementBody(actor: Actor, props: MovementProperties): { velocity: Vec3; ground: Vec3 | null } | null {
    if (actor.destroyed || !this.actorFilter(actor) || this.suppressedActors.has(actor) ||
      this.classifier.movementDrive(actor)?.dynamic !== true) return null;
    const bodyId = this.bodyByActor.get(actor.guid);
    if (!bodyId || this.bodyOwnerByActor.get(actor.guid) !== actor) return { velocity: { x: 0, y: 0, z: 0 }, ground: null };
    const velocity = this.backend.getBodyVelocity(bodyId);
    return velocity && { velocity: velocity.linear, ground: this.groundUnder(actor, bodyId, props) };
  }

  /**
   * The normal of the ground within Ground Snap Distance below the body: its
   * own solid shapes swept down, starting a little above their pose so a body
   * resting in contact is not an initial overlap. Hosted shapes, triggers and
   * surfaces steeper than Max Slope Angle never count.
   */
  private groundUnder(actor: Actor, bodyId: string, props: MovementProperties): Vec3 | null {
    const colliders = this.colliders.publishedColliders(actor);
    const pose = this.backend.getBodyTransform(bodyId);
    if (!colliders || !pose) return null;
    const walkable = Math.cos((props.maxSlopeAngle * Math.PI) / 180);
    let ignore: string[] | undefined;
    for (const collider of colliders.values()) {
      if (collider.isTrigger || (collider.actorId ?? actor.guid) !== actor.guid ||
        collider.shape.kind === "mesh" || collider.shape.kind === "chain") continue;
      const offset = collider.translation ? rotateQuatVec(pose.rotation, collider.translation) : undefined;
      const rotation = collider.rotation ? multiplyQuat(pose.rotation, collider.rotation) : pose.rotation;
      const x = pose.position.x + (offset?.x ?? 0), y = pose.position.y + (offset?.y ?? 0), z = pose.position.z + (offset?.z ?? 0);
      ignore ??= [actor.guid, ...(this.hosting.hostedChildren(actor.guid)?.map((child) => child.guid) ?? [])];
      const hit = this.backend.shapeSweep(collider.shape,
        { position: { x, y: y + GROUND_PROBE_LIFT, z }, rotation },
        { position: { x, y: y - props.groundSnapDistance - GROUND_PROBE_MARGIN, z }, rotation },
        { ignoreActorIds: ignore, includeTriggers: false });
      if (hit.hit && hit.normal && hit.normal.y >= walkable) return { ...hit.normal };
    }
    return null;
  }

  /**
   * How Movement moves the actor, as `PhysicsBodyClassifier.classify` resolves
   * it; undefined when there is no Movement or another motion owner (Nav Agent,
   * Ragdoll, Water Buoyancy, a second Movement or a static Rigid Body) stops it.
   */
  movementDrive(actor: Actor): MovementDrive | undefined {
    return this.classifier.movementDrive(actor);
  }

  /**
   * `world` resolves the actor's current world pose; it runs only after the
   * actor is known to have a body source, so body-less actors compose nothing.
   */
  private createForActor(actor: Actor, world: (actor: Actor) => Transform): void {
    if (this.suppressedActors.has(actor)) return;
    const rigid = this.classifier.rigidComponent(actor);
    const drive = this.classifier.movementDrive(actor);
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
      !drive &&
      !tilemap &&
      !blocking &&
      this.colliders.meshes.meshPhysicsComponents(actor).length === 0 &&
      this.colliders.meshes.landscapePhysicsComponents(actor).length === 0 &&
      this.colliders.meshes.dynamicMeshPhysicsComponents(actor).length === 0
    )
      return;
    // A hosted actor's solid shapes live on its host; only triggers need a body.
    if (this.hosting.isHosted(actor.guid) && !hasTriggerCollider(actor)) return;
    const bodyId = `body:${actor.guid}`;
    const kinematicCapsule = drive !== undefined && !drive.dynamic;
    const lockRotation = drive?.dynamic === true;
    const props = kinematicCapsule ? MOVEMENT_BODY_PROPERTIES : rigid
      ? this.classifier.rigidProps(rigid)
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
      lockRotation,
      transform: pose,
      reportContacts: this.claimContactReporting(actor),
    });
    try {
      this.applyActorColliders(actor, bodyId, resolved, drive ?? null);
      this.bodyByActor.set(actor.guid, bodyId);
      this.bodyOwnerByActor.set(actor.guid, actor);
      this.appliedBodyProperties.set(actor.guid, {
        component: kinematicCapsule ? drive.component : rigid ?? null,
        value: kinematicCapsule || rigid ? props : STATIC_BODY_PROPERTIES,
        lockRotation,
      });
      this.invalidateChannels();
      // Creation already installed this pose; caching it keeps later syncs
      // from teleporting an unchanged static body every tick.
      if (props.motionType === "static") this.staticPoses.set(actor.guid, physicsPoseDescriptor(pose));
    } catch (error) {
      this.backend.destroyBody(bodyId);
      this.colliders.forgetFailedBody(actor.guid);
      throw error;
    }
  }

  /**
   * Publish the actor's collider set, with the shapes it hosts, as one native
   * batch (`PhysicsColliderSets.publish`). `world` is the actor's resolved
   * world pose: the pre-step pass for per-tick callers, its own current chain
   * for call-time callers. Per-tick callers pass the Movement drive they
   * already resolved.
   */
  private applyActorColliders(
    actor: Actor,
    bodyId: string,
    world: Transform,
    drive: MovementDrive | null = this.classifier.movementDrive(actor) ?? null,
  ): void {
    const hosted = this.hosting.shapes(actor, world.scale);
    // A hosted actor's own body keeps only its triggers.
    const triggersOnly = this.hosting.isHosted(actor.guid);
    this.colliders.publish(actor, bodyId, world, drive, hosted, triggersOnly);
  }
}

/** A resolved world pose as a native body pose; scale stays with colliders. */
function physicsPose(world: Transform): PhysicsTransform {
  return {
    position: { ...world.position },
    rotation: { ...world.rotation },
  };
}

/** Ground probe: shapes start this far above their pose and reach Ground Snap Distance plus the margin below it. */
const GROUND_PROBE_LIFT = 0.05;
const GROUND_PROBE_MARGIN = 0.02;

function physicsPoseDescriptor(pose: PhysicsTransform): readonly number[] {
  return [pose.position.x, pose.position.y, pose.position.z,
    pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w];
}
