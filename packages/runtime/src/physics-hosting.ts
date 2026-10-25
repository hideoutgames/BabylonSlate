import type { Transform } from "@haptic/core";
import type { Vec3 } from "@haptic/physics";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { actorParentGuid, composeParentChildTransform } from "./actor-world-transform";

/** What `PhysicsHosting` uses of `PhysicsWorldSync`. */
export interface PhysicsHostingHost {
  /** The live actor holding `guid`. Ancestor walks call it unbound. */
  readonly findLiveActor: (guid: string) => Actor | undefined;
  /** The World's actor count, which bounds a parent walk. */
  actorCount(): number;
  isStaticSource(source: ActorComponent | null): boolean;
  hasSolidCollision(actor: Actor): boolean;
}

/** How an actor's body moves, for choosing the host of its static descendants. */
export type BodyMotion = "simulated" | "static" | "none";

/** A hosted child and its pose (with composed scale) in its host's body frame. */
export type HostedShape = { actor: Actor; relative: Transform };

/**
 * Hosting of collidable statics on their nearest dynamic or kinematic
 * ancestor's compound body, like a child collider: the per-tick assignment,
 * call-time moves, and each hosted shape's pose in its host's body frame.
 */
export class PhysicsHosting {
  private readonly host: PhysicsHostingHost;
  /**
   * Collidable static actors whose solid shapes their nearest dynamic or
   * kinematic ancestor's body hosts, and each host's children in world order.
   * The per-tick pass rebuilds both; call-time paths adjust one actor.
   */
  private hostByActor = new Map<string, Actor>();
  /** The previous pass's `hostByActor`, kept only so `assign` can tell whether hosting changed. */
  private hostScratch = new Map<string, Actor>();
  private readonly hostedByHost = new Map<string, Actor[]>();
  private readonly passHosts = new Map<Actor, Actor | null>();
  private readonly ancestorScratch: Actor[] = [];
  private readonly chainScratch: Actor[] = [];
  private readonly relativeSeed: Transform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };

  constructor(host: PhysicsHostingHost) {
    this.host = host;
  }

  /** Hosts by hosted actor guid. Read it at each use: every pass swaps the map. */
  get hosts(): ReadonlyMap<string, Actor> {
    return this.hostByActor;
  }

  hostOf(guid: string): Actor | undefined {
    return this.hostByActor.get(guid);
  }

  isHosted(guid: string): boolean {
    return this.hostByActor.has(guid);
  }

  /** The actors `hostGuid` hosts, in world order. */
  hostedChildren(hostGuid: string): readonly Actor[] | undefined {
    return this.hostedByHost.get(hostGuid);
  }

  /**
   * Assign each collidable static body source to its nearest dynamic or
   * kinematic ancestor for this pass, in world order. Static and nonphysics
   * ancestors in between do not host; a destroyed parent ends the chain.
   * Returns whether the assignment changed.
   */
  assign(sources: ReadonlyMap<Actor, ActorComponent | null>): boolean {
    const previous = this.hostByActor;
    this.hostByActor = this.hostScratch;
    this.hostScratch = previous;
    this.hostByActor.clear();
    this.hostedByHost.clear();
    const memo = this.passHosts;
    memo.clear();
    const motion = (actor: Actor): BodyMotion => {
      const source = sources.get(actor);
      return source === undefined ? "none" : this.host.isStaticSource(source) ? "static" : "simulated";
    };
    for (const [actor, source] of sources) {
      if (!this.host.isStaticSource(source)) continue;
      // The memoized ancestor walk comes first, so only statics under a
      // simulated body pay for a second component scan.
      const host = this.simulatedAncestor(actor, motion, this.host.findLiveActor, memo);
      if (host && this.host.hasSolidCollision(actor)) this.hostActor(actor, host);
    }
    memo.clear();
    // The pass rebuilds hosting every tick; only a different assignment changes what channels ignore.
    let changed = previous.size !== this.hostByActor.size;
    if (!changed) for (const [guid, host] of this.hostByActor) if (previous.get(guid) !== host) { changed = true; break; }
    previous.clear();
    return changed;
  }

  /**
   * The nearest ancestor whose body is dynamic or kinematic. `memo` maps each
   * visited ancestor to the nearest such actor among itself and its own
   * ancestors, so one pass walks every chain once.
   */
  simulatedAncestor(
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
    for (let depth = 0; depth <= this.host.actorCount(); depth++) {
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
   * Call-time move of one actor from its `previous` host, if any, to `host`,
   * if any. The caller rebuilds both compounds.
   */
  move(actor: Actor, previous: Actor | undefined, host: Actor | null): void {
    if (previous) {
      const hosted = this.hostedByHost.get(previous.guid);
      const index = hosted?.indexOf(actor) ?? -1;
      if (index >= 0) hosted!.splice(index, 1);
      this.hostByActor.delete(actor.guid);
    }
    if (host) this.hostActor(actor, host);
  }

  /**
   * Shapes `host` takes over from its hosted children, each with its pose in
   * the host's body frame.
   */
  shapes(host: Actor, scale: Vec3): HostedShape[] | undefined {
    const hosted = this.hostedByHost.get(host.guid);
    if (!hosted?.length) return undefined;
    const shapes: HostedShape[] = [];
    for (const actor of hosted) {
      if (actor.destroyed || this.hostByActor.get(actor.guid) !== host) continue;
      const relative = this.relativeTransform(host, scale, actor);
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
  relativeTransform(host: Actor, scale: Vec3, actor: Actor): Transform | null {
    const chain = this.chainScratch;
    chain.length = 0;
    let current: Actor | undefined = actor;
    while (current !== host) {
      if (!current || current.destroyed || chain.length > this.host.actorCount()) {
        chain.length = 0;
        return null;
      }
      chain.push(current);
      const parentId = actorParentGuid(current);
      current = parentId ? this.host.findLiveActor(parentId) : undefined;
    }
    if (chain.length === 0) {
      return {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { ...scale },
      };
    }
    // Only the first composition reads this seed, so it is never returned and
    // its scale is rewritten per call (position and rotation stay identity).
    const seed = this.relativeSeed;
    seed.scale.x = scale.x;
    seed.scale.y = scale.y;
    seed.scale.z = scale.z;
    let transform = seed;
    for (let index = chain.length - 1; index >= 0; index--)
      transform = composeParentChildTransform(transform, chain[index]!.transform);
    chain.length = 0;
    return transform;
  }

  /** What `PhysicsWorldSync.dispose` releases. */
  clear(): void {
    this.hostByActor.clear();
    this.hostScratch.clear();
    this.hostedByHost.clear();
    this.passHosts.clear();
  }
}

export function unitQuaternion(rotation: Transform["rotation"]): Transform["rotation"] {
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (length === 0 || !Number.isFinite(length)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: rotation.x / length, y: rotation.y / length, z: rotation.z / length, w: rotation.w / length };
}
