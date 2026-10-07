import type { CommandMessage, DebugNavAgent } from "@babylonslate/bridge";
import { eulerDegreesToQuaternion, type Transform } from "@babylonslate/core";
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
  type NavObstacleKind,
  type NavPoint,
} from "@babylonslate/navigation";
import { actorChainWorldTransform, composeActorWorldTransforms, firstSpawnedWorldTransforms } from "./actor-world-transform";
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
  dt(): number;
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
  private readonly navYawByActor = new Map<string, number>();
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
    this.clearAgents();
  }

  /** Select the realizing Scene's baked navmesh, or none, before its actors spawn. */
  prepareScene(sceneGuid: string, refresh: boolean): void {
    const bytes = this.sceneNavmeshBytes.get(sceneGuid);
    if (bytes && (refresh || this.navSceneGuid !== sceneGuid)) {
      const nav = createNavigationBackend();
      try { nav.importNavMesh(bytes); } catch (error) { nav.dispose(); throw error; }
      this.clearAgents();
      this.nav?.dispose();
      this.nav = nav;
      this.navSceneGuid = sceneGuid;
    } else if (!bytes) {
      this.clearAgents();
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

  /** A streamed actor left its instance: drop its agent and pending request. */
  removeActor(actorGuid: string): void {
    const agent = this.navAgentByActor.get(actorGuid);
    if (agent) this.nav?.removeAgent(agent);
    this.navAgentByActor.delete(actorGuid);
    this.navTargetByActor.delete(actorGuid);
    this.navYawByActor.delete(actorGuid);
    this.navSteeredActors.delete(actorGuid);
  }

  /** Rotate To Face also turns a crowd agent's heading. */
  faceYaw(actorGuid: string, yawRad: number): void {
    if (this.navAgentByActor.has(actorGuid)) {
      this.navYawByActor.set(actorGuid, yawRad);
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
    this.navYawByActor.clear();
    this.navTargetByActor.clear();
    this.navSteeredActors.clear();
  }

  private isDynamicNavActor(actor: Actor): boolean {
    if (this.host.worldKind() !== "3d") return false;
    const rigid = actor.components.find(
      (component) => component.classId === "RigidBodyComponent" && !component.destroyed,
    );
    return !!rigid && parseRigidBodyProperties(Object.fromEntries(rigid.variables)).motionType === "dynamic";
  }

  /** Current pose through the actor's own chain; parents resolve first-spawned. */
  private navActorWorldPosition(actor: Actor): NavPoint {
    const world = this.host.world();
    return actorChainWorldTransform(actor, (guid) => world.findActor(guid))?.position ?? actor.transform.position;
  }

  /**
   * Resolve an actor through the frame index, which answers each guid with its
   * first-spawned live actor (`World.findActor`). An indexed actor destroyed
   * since the index was built falls back to the live World's answer.
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
    transforms = firstSpawnedWorldTransforms(this.host.world().getActors()),
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
    // Agents are keyed by guid; only the guid's first-spawned actor owns one.
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
    const transforms = firstSpawnedWorldTransforms(this.host.world().getActors(), actors);
    for (const actor of actors) {
      if (actor.destroyed || !this.host.streamActorReady(actor)) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const props = parseNavMeshBlockerProperties(
        Object.fromEntries(component.variables),
      );
      const transform = transforms.get(actor.guid) ?? actor.transform;
      const aabb = rotatedBoxWorldAabb(
        [
          transform.position.x,
          transform.position.y,
          transform.position.z,
        ],
        [
          transform.rotation.x,
          transform.rotation.y,
          transform.rotation.z,
          transform.rotation.w,
        ],
        [
          transform.scale.x,
          transform.scale.y,
          transform.scale.z,
        ],
      );
      const pose = this.toNavObstaclePose(aabb.center);
      const navSize = this.toNavObstacleSize(aabb.size);
      if (props.area === "cost") {
        // Cost volumes mutate the parent's baked navmesh and cannot be removed.
        // Streamed instances therefore share its existing navigation costs.
        if (this.host.isStreamActor(actor)) continue;
        this.nav.applyCostVolume({
          id: actor.guid,
          kind: props.kind,
          pose,
          size: navSize,
          cost: props.cost,
        });
        continue;
      }
      if (!props.dynamic) continue;
      const obstacle = this.nav.addObstacle("box", pose, navSize);
      acquired?.push(obstacle);
    }
  }

  private syncNavCostVolumes(): void {
    if (!this.nav) return;
    for (const actor of this.host.world().getActors()) {
      if (actor.destroyed || this.host.isStreamActor(actor)) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "NavMeshBlockerComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const props = parseNavMeshBlockerProperties(
        Object.fromEntries(component.variables),
      );
      if (props.area !== "cost" || !props.dynamic) continue;
      const aabb = rotatedBoxWorldAabb(
        [
          actor.transform.position.x,
          actor.transform.position.y,
          actor.transform.position.z,
        ],
        [
          actor.transform.rotation.x,
          actor.transform.rotation.y,
          actor.transform.rotation.z,
          actor.transform.rotation.w,
        ],
        [
          actor.transform.scale.x,
          actor.transform.scale.y,
          actor.transform.scale.z,
        ],
      );
      this.nav.applyCostVolume({
        id: actor.guid,
        kind: props.kind,
        pose: this.toNavObstaclePose(aabb.center),
        size: this.toNavObstacleSize(aabb.size),
        cost: props.cost,
      });
    }
  }

  tickCrowd(actors: ReadonlyMap<string, Actor>): void {
    if (!this.nav) return;
    this.syncNavCostVolumes();
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
        this.navYawByActor.delete(actorGuid);
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
    this.nav.stepCrowd(this.host.dt());
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
      const position = this.nav.agentPosition(agentId);
      if (!position) continue;
      const world = this.fromNav(position);
      const velocity = this.nav.agentVelocity(agentId) ?? { x: 0, y: 0, z: 0 };
      const previous = this.navYawByActor.get(actorGuid) ?? 0;
      const yaw = facingYawFromVelocity(velocity, previous);
      this.navYawByActor.set(actorGuid, yaw);
      const euler =
        this.host.worldKind() === "2d"
          ? ([0, 0, (yaw * 180) / Math.PI] as [number, number, number])
          : ([0, (yaw * 180) / Math.PI, 0] as [number, number, number]);
      const quat = eulerDegreesToQuaternion(euler);
      const local = actorLocalPhysicsTransform({
        position: world,
        rotation: { x: quat[0], y: quat[1], z: quat[2], w: quat[3] },
      }, actor, worldTransforms);
      Object.assign(actor.transform.position, local.position);
      Object.assign(actor.transform.rotation, local.rotation);
    }
    physicalAgents.clear();
    if (removed) this.emitDebug(true);
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
    const distance = Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
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
