import type { CommandMessage, DebugNavAgent } from "@babylonslate/bridge";
import { eulerDegreesToQuaternion, type Quat, type Transform } from "@babylonslate/core";
import type { Actor, World } from "@babylonslate/object-model";
import { parseRigidBodyProperties, type PhysicsWorldKind } from "@babylonslate/physics";
import type { BtResult } from "@babylonslate/behaviour-tree";
import {
  createNavigationBackend,
  facingYawFromVelocity,
  parseNavAgentParams,
  parseNavMeshBlockerProperties,
  recastToWorld,
  rotatedBoxWorldAabb,
  worldToRecast,
  type NavigationBackend,
  type NavMeshBlockerProperties,
  type NavObstacleKind,
  type NavPoint,
} from "@babylonslate/navigation";
import {
  actorChainWorldTransform,
  actorParentGuid,
  composeActorWorldTransforms,
  actorWorldTransforms,
} from "./actor-world-transform";
import { actorLocalPhysicsTransform, type PhysicsWorldSync } from "./physics-sync";
import type { RuntimeSubsystem } from "./runtime-subsystems";

interface RuntimeNavigationHost {
  world(): World;
  /** The main Scene's physics world kind; 2D maps XY to Recast XZ. */
  worldKind(): PhysicsWorldKind;
  /** Main-Scene physics, which steers dynamic agents by velocity. */
  physics(): PhysicsWorldSync;
  streamActorReady(actor: Actor): boolean;
  /** The actor belongs to a streamed Scene instance. */
  isStreamActor(actor: Actor): boolean;
  actorName(actor: Actor): string;
  emit(command: CommandMessage): void;
}

export function navPointFromUnknown(value: unknown): NavPoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof row.x !== "number" || !Number.isFinite(row.x)) return null;
  return {
    x: row.x,
    y: typeof row.y === "number" && Number.isFinite(row.y) ? row.y : 0,
    z: typeof row.z === "number" && Number.isFinite(row.z) ? row.z : 0,
  };
}

/**
 * Baked Scene navmeshes, the crowd and its agents, obstacles and cost volumes,
 * plus the pathfinding / nav-agent debug stream.
 */
export class RuntimeNavigation implements RuntimeSubsystem {
  private nav: NavigationBackend | null = null;
  private readonly sceneNavmeshBytes = new Map<string, Uint8Array>();
  private navSceneGuid: string | null = null;
  private navigationInitialized = false;
  private readonly navAgentByActor = new Map<string, string>();
  /** A Rotate To Face heading the next crowd tick applies to an idle agent. */
  private readonly navFacingRequests = new Map<string, number>();
  /** Dynamic unwalkable blocker obstacles, removed when their blocker no longer applies. */
  private readonly navObstacleByActor = new Map<string, { actor: Actor; id: string }>();
  /** Blockers whose cost volume is applied, keyed like the volume by actor guid. */
  private readonly navCostVolumeActors = new Map<string, Actor>();
  private readonly navTargetByActor = new Map<string, NavPoint>();
  private readonly navSteeredActors = new Set<string>();
  private readonly navPhysicalAgents = new Set<string>();
  private readonly navAgentActors: Actor[] = [];
  private showPathfinding = false;
  private showNavAgent = false;
  private lastNavigationDebugMs = -Infinity;
  private readonly host: RuntimeNavigationHost;
  private readonly now: () => number;

  constructor(host: RuntimeNavigationHost, now: () => number) {
    this.host = host;
    this.now = now;
  }

  /** A navmesh is loaded for the current Scene. */
  get active(): boolean {
    return this.nav !== null;
  }

  /** Replace the baked navmesh catalog (keyed by canonical Scene guid). */
  replaceSceneNavMeshes(bytes: Readonly<Record<string, Uint8Array>>): void {
    this.sceneNavmeshBytes.clear();
    for (const [guid, value] of Object.entries(bytes)) this.sceneNavmeshBytes.set(guid, value);
  }

  setSceneNavMesh(sceneGuid: string, bytes: Uint8Array): void {
    this.sceneNavmeshBytes.set(sceneGuid, bytes);
  }

  /** Recast wasm must initialize before this Scene's baked navmesh can import. */
  needsInitialization(sceneGuid: string): boolean {
    return this.sceneNavmeshBytes.has(sceneGuid) && !this.navigationInitialized;
  }

  markInitialized(): void {
    this.navigationInitialized = true;
  }

  /** Import a navmesh for the current Scene into the existing (or a new) backend. */
  importNavMesh(sceneGuid: string, bytes: Uint8Array): void {
    this.nav ??= createNavigationBackend();
    this.nav.importNavMesh(bytes);
    this.navSceneGuid = sceneGuid;
    this.releaseSteering();
    this.clearAgents();
    this.forgetBlockers();
  }

  /** Select the realizing Scene's baked navmesh, or none, before its actors spawn. */
  prepareScene(sceneGuid: string, refresh: boolean): void {
    const bytes = this.sceneNavmeshBytes.get(sceneGuid);
    if (bytes && (refresh || this.navSceneGuid !== sceneGuid)) {
      const nav = createNavigationBackend();
      try { nav.importNavMesh(bytes); } catch (error) { nav.dispose(); throw error; }
      this.releaseSteering();
      this.clearAgents();
      this.forgetBlockers();
      this.nav?.dispose();
      this.nav = nav;
      this.navSceneGuid = sceneGuid;
    } else if (!bytes) {
      this.releaseSteering();
      this.clearAgents();
      this.forgetBlockers();
      this.nav?.dispose();
      this.nav = null;
      this.navSceneGuid = null;
    }
  }

  /** Departing Scene actors left: their crowd agents go with them. */
  resetForSceneLoad(): void {
    this.clearAgents();
  }

  dispose(): void {
    this.clearAgents();
    this.forgetBlockers();
    this.nav?.dispose();
    this.nav = null;
    this.sceneNavmeshBytes.clear();
    if (this.showPathfinding || this.showNavAgent) {
      this.host.emit({ type: "debugNavigation", agents: [], world: this.host.worldKind() });
    }
  }

  setAgentTarget(actorGuid: string, target: NavPoint): boolean {
    if (!this.nav) return false;
    const actor = this.host.world().findActor(actorGuid);
    if (!actor || actor.destroyed || !actor.components.some(
      (component) => component.classId === "NavAgentComponent" && !component.destroyed,
    )) return false;
    const destination = this.nav.closestPoint(this.toNav(target));
    if (!destination) return false;
    if (!this.navAgentByActor.has(actorGuid)) {
      this.registerAgent(actor);
    }
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId && !this.isDynamicNavActor(actor)) return false;
    if (agentId && !this.nav.setAgentTarget(agentId, destination)) return false;
    // A falling actor may not be close enough to a polygon yet. Keep its
    // request until physics brings it within reach of the mesh.
    this.navTargetByActor.set(actorGuid, { ...destination });
    this.emitDebug(true);
    return true;
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    if (!this.nav) return [];
    return this.nav.findPath(this.toNav(from), this.toNav(to)).map((point) =>
      this.fromNav(point),
    );
  }

  closestNavigablePoint(point: NavPoint): NavPoint | null {
    if (!this.nav) return null;
    const closest = this.nav.closestPoint(this.toNav(point));
    return closest ? this.fromNav(closest) : null;
  }

  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null {
    if (!this.nav) return null;
    const point = this.nav.randomPointInRadius(this.toNav(center), radius);
    return point ? this.fromNav(point) : null;
  }

  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string {
    if (!this.nav) return "";
    return this.nav.addObstacle(
      kind,
      this.toNavObstaclePose(pose),
      this.toNavObstacleSize(size),
    );
  }

  removeObstacle(id: string): void {
    this.nav?.removeObstacle(id);
  }

  stopAgent(actorGuid: string): void {
    this.navTargetByActor.delete(actorGuid);
    if (this.navSteeredActors.delete(actorGuid)) {
      this.host.physics().setActorLinearVelocity(actorGuid, { x: 0, z: 0 });
    }
    const agentId = this.navAgentByActor.get(actorGuid);
    if (!agentId || !this.nav) return;
    this.nav.stopAgent(agentId);
    this.emitDebug(true);
  }

  /**
   * A departing actor's agent and requests leave with it, so an actor that
   * later reuses its guid (a reloaded Scene or Save Game actor) starts fresh.
   */
  retireActor(actor: Actor): void {
    this.forgetDeparted(actor);
  }

  /** A script-destroyed actor's slot returns after the World removed it. */
  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) this.forgetDeparted(owner);
  }

  private forgetDeparted(actor: Actor): void {
    const live = this.host.world().findActor(actor.guid);
    if (!live || live === actor) this.removeActor(actor.guid);
  }

  /** A streamed actor left its instance: drop its agent and pending request. */
  removeActor(actorGuid: string): void {
    const agent = this.navAgentByActor.get(actorGuid);
    if (agent) this.nav?.removeAgent(agent);
    this.navAgentByActor.delete(actorGuid);
    this.navTargetByActor.delete(actorGuid);
    this.navFacingRequests.delete(actorGuid);
    this.navSteeredActors.delete(actorGuid);
    // A departed blocker stops carving and pricing the navmesh.
    const obstacle = this.navObstacleByActor.get(actorGuid);
    if (obstacle) this.nav?.removeObstacle(obstacle.id);
    this.navObstacleByActor.delete(actorGuid);
    if (this.navCostVolumeActors.delete(actorGuid)) this.nav?.removeCostVolume(actorGuid);
  }

  /**
   * Rotate To Face on a crowd agent: an idle agent takes this heading (radians,
   * Rotate To Face's convention) on the next crowd tick; a moving one faces
   * its velocity instead.
   */
  faceYaw(actorGuid: string, yawRad: number): void {
    if (this.navAgentByActor.has(actorGuid)) {
      this.navFacingRequests.set(actorGuid, yawRad);
    }
  }

  private toNav(point: NavPoint): NavPoint {
    return this.host.worldKind() === "2d" ? worldToRecast(point) : point;
  }

  private fromNav(point: NavPoint): NavPoint {
    return this.host.worldKind() === "2d" ? recastToWorld(point) : point;
  }

  /** Recast obstacle pose: 2D XY sits on a 2-unit-tall volume centered at Y=1. */
  private toNavObstaclePose(point: NavPoint): NavPoint {
    if (this.host.worldKind() !== "2d") return point;
    const recast = worldToRecast(point);
    return { x: recast.x, y: 1, z: recast.z };
  }

  /** Recast obstacle size: 2D (width, height) → Recast (X, up=2, Z). */
  private toNavObstacleSize(size: NavPoint): NavPoint {
    if (this.host.worldKind() !== "2d") return size;
    return {
      x: Math.abs(size.x) || 1,
      y: 2,
      z: Math.abs(size.y) || 1,
    };
  }

  private clearAgents(): void {
    if (this.nav) {
      for (const agentId of this.navAgentByActor.values()) {
        this.nav.removeAgent(agentId);
      }
    }
    this.navAgentByActor.clear();
    this.navFacingRequests.clear();
    this.navTargetByActor.clear();
    this.navSteeredActors.clear();
  }

  /** A replaced navmesh drops its crowd; stop the horizontal velocity it was steering. */
  private releaseSteering(): void {
    for (const actorGuid of this.navSteeredActors) {
      this.host.physics().setActorLinearVelocity(actorGuid, { x: 0, z: 0 });
    }
    this.navSteeredActors.clear();
  }

  /** Blocker obstacles and cost volumes belong to the navmesh they were added to. */
  private forgetBlockers(): void {
    this.navObstacleByActor.clear();
    this.navCostVolumeActors.clear();
  }

  /**
   * Physics steering covers bodies in the main world. A Scene Layer actor's
   * body lives in its layer's own world, so its agent follows the crowd pose
   * like a kinematic one.
   */
  private isDynamicNavActor(actor: Actor): boolean {
    if (this.host.worldKind() !== "3d" || actor.sceneLayerId) return false;
    const rigid = actor.components.find(
      (component) => component.classId === "RigidBodyComponent" && !component.destroyed,
    );
    return !!rigid && parseRigidBodyProperties(Object.fromEntries(rigid.variables)).motionType === "dynamic";
  }

  /** Current pose through the actor's own chain of live parents. */
  private navActorWorldPosition(actor: Actor): NavPoint {
    const world = this.host.world();
    return actorChainWorldTransform(actor, (guid) => world.findActor(guid))?.position ?? actor.transform.position;
  }

  /**
   * Resolve an actor through the frame index of live actors by guid. An
   * indexed actor destroyed since the index was built falls back to the live
   * World's answer (`World.findActor`).
   */
  private navFrameActor(index: ReadonlyMap<string, Actor>, guid: string): Actor | undefined {
    const world = this.host.world();
    const indexed = index.get(guid);
    if (indexed && !indexed.destroyed && indexed.world === world) return indexed;
    return world.findActor(guid);
  }

  /** Compose NavAgent actors and their ancestors, not the whole world. */
  private navAgentWorldTransforms(index: ReadonlyMap<string, Actor>): Map<string, Transform> {
    const actors = this.host.world().getActors();
    const agents = this.navAgentActors;
    agents.length = 0;
    for (const actor of actors) {
      for (const component of actor.components) {
        if (component.classId === "NavAgentComponent" && !component.destroyed) {
          agents.push(actor);
          break;
        }
      }
    }
    try {
      return composeActorWorldTransforms((guid) => this.navFrameActor(index, guid), agents);
    } finally {
      agents.length = 0;
    }
  }

  registerAgents(
    transforms = actorWorldTransforms(this.host.world().getActors()),
  ): void {
    if (!this.nav) return;
    for (const actor of this.host.world().getActors()) {
      this.registerAgent(actor, transforms);
    }
  }

  private registerAgent(
    actor: Actor,
    transforms?: ReadonlyMap<string, Transform>,
  ): void {
    if (!this.nav || actor.destroyed || !this.host.streamActorReady(actor)) return;
    if (this.navAgentByActor.has(actor.guid)) return;
    // Agents are keyed by guid and belong to the live actor holding it.
    if (this.host.world().findActor(actor.guid) !== actor) return;
    const component = actor.components.find(
      (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
    );
    if (!component) return;
    const params = parseNavAgentParams(
      Object.fromEntries(component.variables),
    );
    const world = this.toNav(transforms?.get(actor.guid)?.position ?? this.navActorWorldPosition(actor));
    const position = this.isDynamicNavActor(actor) ? this.nav.closestPoint(world) : world;
    if (!position) return;
    const id = this.nav.addAgent(position, params);
    if (!id) return;
    this.navAgentByActor.set(actor.guid, id);
    const target = this.navTargetByActor.get(actor.guid);
    if (target) this.nav.setAgentTarget(id, target);
  }

  updateAgentParams(actor: Actor): void {
    const agentId = this.navAgentByActor.get(actor.guid);
    if (!agentId || !this.nav) return;
    const component = actor.components.find(
      (entry) => entry.classId === "NavAgentComponent" && !entry.destroyed,
    );
    if (!component) return;
    this.nav.updateAgent(
      agentId,
      parseNavAgentParams(Object.fromEntries(component.variables)),
    );
  }

  registerObstacles(actors: readonly Actor[] = this.host.world().getActors(), acquired?: string[]): void {
    if (!this.nav) return;
    const transforms = actorWorldTransforms(this.host.world().getActors(), actors);
    for (const actor of actors) {
      if (actor.destroyed || !this.host.streamActorReady(actor)) continue;
      const props = this.blockerProperties(actor);
      if (!props) continue;
      const transform = transforms.get(actor.guid) ?? actor.transform;
      if (props.area === "cost") {
        // Streamed instances keep the main Scene's navigation costs.
        if (this.host.isStreamActor(actor)) continue;
        this.applyCostVolume(actor, props, transform);
        continue;
      }
      if (!props.dynamic || this.navObstacleByActor.get(actor.guid)?.actor === actor) continue;
      const obstacle = this.blockerObstacle(props.kind, transform);
      const id = this.nav.addObstacle(obstacle.kind, obstacle.pose, obstacle.size, obstacle.yaw);
      if (!id) continue;
      this.navObstacleByActor.set(actor.guid, { actor, id });
      acquired?.push(id);
    }
  }

  private blockerProperties(actor: Actor): NavMeshBlockerProperties | null {
    const component = actor.components.find(
      (entry) => entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
    );
    return component ? parseNavMeshBlockerProperties(Object.fromEntries(component.variables)) : null;
  }

  /** Cost volumes price the world AABB of the blocker's volume. */
  private applyCostVolume(actor: Actor, props: NavMeshBlockerProperties, transform: Transform): void {
    const aabb = rotatedBoxWorldAabb(
      [transform.position.x, transform.position.y, transform.position.z],
      [transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w],
      [transform.scale.x, transform.scale.y, transform.scale.z],
    );
    this.nav?.applyCostVolume({
      id: actor.guid,
      kind: props.kind,
      pose: this.toNavObstaclePose(aabb.center),
      size: this.toNavObstacleSize(aabb.size),
      cost: props.cost,
    });
    this.navCostVolumeActors.set(actor.guid, actor);
  }

  /**
   * A tile-cache obstacle for a blocker's world volume. An upright volume
   * (turned only about the walk plane's normal) keeps its shape and yaw;
   * any tilt falls back to a box over its world AABB.
   */
  private blockerObstacle(
    kind: NavObstacleKind,
    transform: Transform,
  ): { kind: NavObstacleKind; pose: NavPoint; size: NavPoint; yaw: number } {
    const { x, y, z, w } = normalizedQuat(transform.rotation);
    const twoD = this.host.worldKind() === "2d";
    if (Math.abs(x) < UPRIGHT_EPSILON && Math.abs(twoD ? y : z) < UPRIGHT_EPSILON) {
      const turn = 2 * Math.atan2(twoD ? z : y, w);
      return {
        kind,
        pose: this.toNavObstaclePose(transform.position),
        size: this.toNavObstacleSize({
          x: Math.abs(transform.scale.x),
          y: Math.abs(transform.scale.y),
          z: Math.abs(transform.scale.z),
        }),
        // Recast turns about +Y; a 2D turn about +Z maps onto it reversed.
        yaw: twoD ? -turn : turn,
      };
    }
    const aabb = rotatedBoxWorldAabb(
      [transform.position.x, transform.position.y, transform.position.z],
      [x, y, z, w],
      [transform.scale.x, transform.scale.y, transform.scale.z],
    );
    return {
      kind: "box",
      pose: this.toNavObstaclePose(aabb.center),
      size: this.toNavObstacleSize(aabb.size),
      yaw: 0,
    };
  }

  /** Drop obstacles and cost volumes whose blocker left, lost its component, or changed area. */
  private syncNavBlockers(index: ReadonlyMap<string, Actor>): void {
    if (!this.nav) return;
    const applies = (actor: Actor, area: "cost" | "unwalkable") => {
      if (actor.destroyed || this.navFrameActor(index, actor.guid) !== actor) return false;
      const props = this.blockerProperties(actor);
      return !!props && props.area === area && (area === "cost" || props.dynamic);
    };
    for (const [actorGuid, obstacle] of this.navObstacleByActor) {
      if (applies(obstacle.actor, "unwalkable")) continue;
      this.nav.removeObstacle(obstacle.id);
      this.navObstacleByActor.delete(actorGuid);
    }
    for (const [actorGuid, actor] of this.navCostVolumeActors) {
      if (applies(actor, "cost")) continue;
      this.nav.removeCostVolume(actorGuid);
      this.navCostVolumeActors.delete(actorGuid);
    }
  }

  /** Moving dynamic cost blockers restamp from their current world pose. */
  private syncNavCostVolumes(index: ReadonlyMap<string, Actor>): void {
    if (!this.nav) return;
    const moving: Array<{ actor: Actor; props: NavMeshBlockerProperties }> = [];
    for (const actor of this.host.world().getActors()) {
      if (actor.destroyed || this.host.isStreamActor(actor)) continue;
      const props = this.blockerProperties(actor);
      if (props?.area === "cost" && props.dynamic) moving.push({ actor, props });
    }
    if (moving.length === 0) return;
    const transforms = composeActorWorldTransforms(
      (guid) => this.navFrameActor(index, guid),
      moving.map((entry) => entry.actor),
    );
    for (const { actor, props } of moving) {
      this.applyCostVolume(actor, props, transforms.get(actor.guid) ?? actor.transform);
    }
  }

  /** One crowd step; `dtSeconds` is the tick's captured step. */
  tickCrowd(actors: ReadonlyMap<string, Actor>, dtSeconds: number): void {
    if (!this.nav) return;
    this.syncNavBlockers(actors);
    this.syncNavCostVolumes(actors);
    const worldTransforms = this.navAgentWorldTransforms(actors);
    this.registerAgents(worldTransforms);
    const physicalAgents = this.navPhysicalAgents;
    physicalAgents.clear();
    let removed = false;
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.navFrameActor(actors, actorGuid);
      if (!actor || actor.destroyed || !this.host.streamActorReady(actor) || !actor.components.some((component) =>
        component.classId === "NavAgentComponent" && !component.destroyed)) {
        this.stopAgent(actorGuid);
        this.nav.removeAgent(agentId);
        this.navAgentByActor.delete(actorGuid);
        this.navFacingRequests.delete(actorGuid);
        removed = true;
        continue;
      }
      if (!this.isDynamicNavActor(actor)) continue;
      const position = worldTransforms.get(actorGuid)?.position ?? actor.transform.position;
      if (this.nav.syncAgentPosition(agentId, position)) {
        physicalAgents.add(actorGuid);
      } else {
        // Physics may carry an actor away from the mesh (for example a jump).
        // Reattach with the pending target once its physical pose is reachable.
        this.nav.removeAgent(agentId);
        this.navAgentByActor.delete(actorGuid);
        removed = true;
        if (this.navSteeredActors.delete(actorGuid)) {
          this.host.physics().setActorLinearVelocity(actorGuid, { x: 0, z: 0 });
        }
      }
    }
    this.nav.stepCrowd(dtSeconds);
    const posed: Actor[] = [];
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.navFrameActor(actors, actorGuid);
      if (!actor || actor.destroyed) continue;
      if (physicalAgents.has(actorGuid)) {
        if (this.navTargetByActor.has(actorGuid)) {
          const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
          this.host.physics().setActorLinearVelocity(actorGuid, { x: velocity.x, z: velocity.z });
          this.navSteeredActors.add(actorGuid);
        }
        continue;
      }
      posed.push(actor);
    }
    const lookup = (guid: string) => this.navFrameActor(actors, guid);
    // Parents first, so a child agent resolves against its parent's new pose.
    if (posed.length > 1) {
      const depth = new Map(posed.map((actor) => [actor, ancestorCount(actor, lookup)] as const));
      posed.sort((a, b) => depth.get(a)! - depth.get(b)!);
    }
    for (const actor of posed) {
      const agentId = this.navAgentByActor.get(actor.guid)!;
      const position = this.nav.agentPosition(agentId);
      if (!position) continue;
      const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
      // Agents face their movement; an idle agent keeps its facing unless Rotate To Face asked.
      const heading = this.movementHeading(velocity) ?? this.navFacingRequests.get(actor.guid);
      this.navFacingRequests.delete(actor.guid);
      const parentId = actorParentGuid(actor);
      const parent = parentId ? lookup(parentId) : undefined;
      const parentWorld = parent ? actorChainWorldTransform(parent, lookup) : null;
      const rotation = heading !== undefined
        ? this.headingRotation(heading)
        : parentWorld
          ? actorChainWorldTransform(actor, lookup)?.rotation ?? actor.transform.rotation
          : actor.transform.rotation;
      const local = actorLocalPhysicsTransform(
        { position: this.fromNav(position), rotation },
        actor,
        parentId && parentWorld ? new Map([[parentId, parentWorld]]) : NO_TRANSFORMS,
      );
      Object.assign(actor.transform.position, local.position);
      if (heading !== undefined) Object.assign(actor.transform.rotation, local.rotation);
    }
    physicalAgents.clear();
    if (removed) this.emitDebug(true);
  }

  /**
   * Heading from crowd velocity, in Rotate To Face's convention: 3D turns
   * about +Y with +Z forward, 2D about +Z with +X forward. None when idle.
   */
  private movementHeading(velocity: NavPoint): number | undefined {
    const heading = this.host.worldKind() === "2d"
      // Recast Z is world Y: atan2(world y, world x).
      ? facingYawFromVelocity({ x: velocity.z, y: 0, z: velocity.x }, Number.NaN)
      : facingYawFromVelocity(velocity, Number.NaN);
    return Number.isNaN(heading) ? undefined : heading;
  }

  private headingRotation(heading: number): Quat {
    const degrees = (heading * 180) / Math.PI;
    const [x, y, z, w] = eulerDegreesToQuaternion(
      this.host.worldKind() === "2d" ? [0, 0, degrees] : [0, degrees, 0],
    );
    return { x, y, z, w };
  }

  /** Behaviour Tree MoveTo / MoveToBlackboardKey task host. */
  tickMoveTo(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
    memory: Record<string, unknown>,
    dest: NavPoint | null,
  ): BtResult {
    if (!dest) {
      this.stopAgent(actor.guid);
      return "failure";
    }
    const target = this.nav?.closestPoint(this.toNav(dest));
    if (!target) {
      this.stopAgent(actor.guid);
      return "failure";
    }
    const previous = navPointFromUnknown(memory.__moveDestination);
    if (memory.__moveRequested !== true || !previous ||
      previous.x !== dest.x || previous.y !== dest.y || previous.z !== dest.z) {
      if (!this.setAgentTarget(actor.guid, dest)) {
        this.stopAgent(actor.guid);
        return "failure";
      }
      memory.__moveRequested = true;
      memory.__moveDestination = { ...dest };
    }
    const agentId = this.navAgentByActor.get(actor.guid);
    const dynamic = this.isDynamicNavActor(actor);
    const world = dynamic ? this.navActorWorldPosition(actor) : null;
    const position = world
      ? this.nav?.closestPoint(this.toNav(world))
      : agentId ? this.nav?.agentPosition(agentId) : null;
    if (!position) return dynamic && this.navTargetByActor.has(actor.guid) ? "running" : "failure";
    const accept =
      typeof node.properties?.acceptRadius === "number" &&
      Number.isFinite(node.properties.acceptRadius)
        ? Math.max(0, node.properties.acceptRadius)
        : 0.75;
    if (world) {
      const navComponent = actor.components.find((component) =>
        component.classId === "NavAgentComponent" && !component.destroyed);
      const height = parseNavAgentParams(Object.fromEntries(navComponent?.variables ?? [])).height;
      // Root pivots can be at the feet or inside the collider. The crowd is
      // surface-based; do not report arrival for a distant airborne owner.
      if (Math.abs(world.y - position.y) > Math.max(height, accept)) return "running";
    }
    // A physical owner arrives by its own horizontal position, not the nearest
    // navmesh point, which can lie up to the query reach away.
    const horizontal = world ? this.toNav(world) : position;
    const distance = Math.hypot(
      horizontal.x - target.x,
      position.y - target.y,
      horizontal.z - target.z,
    );
    if (distance > accept) return "running";
    this.stopAgent(actor.guid);
    return "success";
  }

  setShowPathfinding(enabled: boolean): void {
    this.showPathfinding = enabled;
    this.host.emit({ type: "setShowPathfinding", enabled });
    this.emitDebug(true);
    if (!this.showPathfinding && !this.showNavAgent) {
      this.host.emit({ type: "debugNavigation", agents: [], world: this.host.worldKind() });
    }
  }

  setShowNavAgent(enabled: boolean): void {
    this.showNavAgent = enabled;
    this.host.emit({ type: "setShowNavAgent", enabled });
    this.emitDebug(true);
    if (!this.showPathfinding && !this.showNavAgent) {
      this.host.emit({ type: "debugNavigation", agents: [], world: this.host.worldKind() });
    }
  }

  /** Stream crowd state while a navigation debug view is on, at most every 200 ms unless forced. */
  emitDebug(force = false): void {
    if (!this.showPathfinding && !this.showNavAgent) return;
    const now = this.now();
    if (!force && now - this.lastNavigationDebugMs < 200) return;
    this.lastNavigationDebugMs = now;
    const agents: DebugNavAgent[] = [];
    for (const [actorGuid, agentId] of this.navAgentByActor) {
      const actor = this.host.world().findActor(actorGuid);
      if (!actor || actor.destroyed) continue;
      const state = this.nav?.agentDebugState(agentId);
      if (!state) continue;
      agents.push({
        ...state,
        actorGuid,
        actorName: this.host.actorName(actor),
        position: this.fromNav(state.position),
        velocity: this.fromNav(state.velocity),
        target: state.target ? this.fromNav(state.target) : null,
        path: state.path.map((point) => this.fromNav(point)),
      });
    }
    this.host.emit({ type: "debugNavigation", agents, world: this.host.worldKind() });
  }
}

const NO_TRANSFORMS: ReadonlyMap<string, Transform> = new Map();
/** Quaternion components below this count as no tilt off the walk plane. */
const UPRIGHT_EPSILON = 1e-5;

function normalizedQuat(rotation: Quat): Quat {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (!(length > 1e-8)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: rotation.x / length, y: rotation.y / length, z: rotation.z / length, w: rotation.w / length };
}

/** How many live ancestors an actor has, stopping at a parent cycle. */
function ancestorCount(actor: Actor, lookup: (guid: string) => Actor | undefined): number {
  let count = 0;
  const visited = new Set([actor.guid]);
  for (let parentId = actorParentGuid(actor); parentId && !visited.has(parentId);) {
    visited.add(parentId);
    const parent = lookup(parentId);
    if (!parent) break;
    count += 1;
    parentId = actorParentGuid(parent);
  }
  return count;
}
