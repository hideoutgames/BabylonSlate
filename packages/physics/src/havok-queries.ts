import "@babylonjs/core/Physics/physicsEngineComponent";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeSphere, type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape";
import type { CastingResult } from "@babylonjs/core/Physics/castingResult";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import { ProximityCastResult } from "@babylonjs/core/Physics/proximityCastResult";
import type { SphereSweepQuery } from "./backend";
import type { ColliderDesc, ColliderShape, HitResult, LineTraceOptions, OverlapResult, PhysicsTransform, Vec3 } from "./types";
import { linearSweepPoses, validateColliderShape } from "./collider-validation";
import { queryHitsTriggers } from "./query-filter";
import {
  colliderShapes,
  createHavokShape,
  isShape3D,
  toQuaternion,
  toVector3,
  type BodyRecord,
  type ColliderRecord,
} from "./havok-records";

/** Native shapes `shapeSweep` keeps for reuse; a script sweeping ever-changing sizes churns within this bound. */
const QUERY_SHAPE_LIMIT = 16;
/** Ignored shapes a query masks up front; past this, each ignored owner is masked only once the query reaches it. */
const EAGER_IGNORED_SHAPES = 16;

function miss(): HitResult {
  return {
    hit: false,
    location: null,
    normal: null,
    distance: 0,
    actorId: null,
    bodyId: null,
  };
}

function shapeOwner(record: BodyRecord, shape: PhysicsShape | undefined): string {
  return shapeCollider(record, shape)?.desc.actorId ?? record.desc.actorId;
}

/** The collider a query hit named on this body; undefined when it names none and the body has several. */
function shapeCollider(record: BodyRecord, shape: PhysicsShape | undefined): ColliderRecord | undefined {
  if (shape)
    for (const collider of record.colliders.values())
      if (collider.shape === shape || collider.proxy === shape) return collider;
  // Havok reports no child shape for a body with a single collider.
  return record.colliders.size === 1 ? record.colliders.values().next().value : undefined;
}

/** What the queries read from the backend that owns the world. */
export interface HavokQueryHost {
  readonly scene: Scene;
  readonly plugin: HavokPlugin;
  readonly bodies: ReadonlyMap<string, BodyRecord>;
  readonly bodyIdByPhysicsBody: ReadonlyMap<PhysicsBody, string>;
  readonly collidersByOwner: ReadonlyMap<string, ReadonlySet<ColliderRecord>>;
  readonly triggerColliders: ReadonlySet<ColliderRecord>;
  isDisposed(): boolean;
  flushMutations(): void;
}

/**
 * The Havok backend's script queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, sphere sweeps) and their per-query
 * filtering, which masks the shapes a query excludes and restores them before returning.
 */
export class HavokQueries {
  private readonly host: HavokQueryHost;
  /** Shapes a running query filter masked and their memberships; empty between queries. */
  private readonly queryMemberships = new Map<PhysicsShape, number>();
  /** The running query's `ignoreActorIds`, peeled as the query reaches them; null between queries and when none. */
  private queryIgnores: ReadonlySet<string> | null = null;
  private readonly sphereSweeps = new Set<SphereSweepQuery>();
  /** Native shapes for primitive `shapeSweep` casts by kind and dimensions, least recently used first (`reusableQueryShape`). */
  private readonly queryShapes = new Map<string, PhysicsShape>();
  /** Result holders the synchronous queries share; the plugin resets them at the start of every query. */
  private readonly proximityInput = new ProximityCastResult();
  private readonly proximityHit = new ProximityCastResult();
  private readonly castInput = new ShapeCastResult();
  private readonly castHit = new ShapeCastResult();
  private readonly tmpFrom = new Vector3();
  private readonly tmpTo = new Vector3();

  constructor(host: HavokQueryHost) {
    this.host = host;
  }

  /** Releases the sphere sweeps and cached query shapes. */
  dispose(): void {
    for (const query of this.sphereSweeps) query.dispose();
    for (const shape of this.queryShapes.values()) shape.dispose();
    this.queryShapes.clear();
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    this.host.flushMutations();
    const engine = this.host.scene.getPhysicsEngine();
    if (!engine) return miss();
    this.tmpFrom.copyFrom(toVector3(start));
    this.tmpTo.copyFrom(toVector3(end));
    return this.withQueryFilter(options, () => {
      // Triggers are hit unless excluded, as on every backend (Babylon's default skips them).
      const shouldHitTriggers = queryHitsTriggers(options);
      const hit = this.untilAdmitted(options, () => engine.raycast(this.tmpFrom, this.tmpTo, { shouldHitTriggers }));
      if (!hit?.hasHit) return miss();
      return this.hitFromCast(hit, hit.hitDistance);
    });
  }

  /**
   * Runs `find`, one native query, and returns its hit. Havok cannot be asked to skip actors or to find trigger shapes
   * alone: all 32 membership bits belong to the collision layers, so none can tag them, and the hit collector keeps
   * one hit, so a rejected hit cannot be dropped afterwards. A query therefore masks each ignored actor or, when
   * trigger-only, each solid shape it reaches and repeats, until it finds an admitted shape or nothing. Its cost
   * follows the rejected shapes ahead of the first admitted one, not the shapes in the world or the length of the
   * ignore list. `withQueryFilter` restores the masks. Null: no admitted shape could be proven hit.
   */
  private untilAdmitted<T extends CastingResult>(options: LineTraceOptions | undefined, find: () => T): T | null {
    for (;;) {
      const result = find();
      if ((!options?.onlyTriggers && !this.queryIgnores) || !result.hasHit) return result;
      const bodyId = result.body ? this.host.bodyIdByPhysicsBody.get(result.body) : undefined;
      const peeled = this.peelHit(options, bodyId ? this.host.bodies.get(bodyId) : undefined, result.shape);
      if (peeled === "keep") return result;
      if (peeled === "stop") return null;
    }
  }

  /**
   * What to do with the shape a query just hit: keep it, or mask its ignored owner's shapes or, for a trigger-only
   * query, its solid collider for a repeat ("peeled"), or give up when it cannot be classified or masking again would
   * not change the next result.
   */
  private peelHit(options: LineTraceOptions | undefined, record: BodyRecord | undefined, shape: PhysicsShape | undefined): "keep" | "peeled" | "stop" {
    const ignored = this.queryIgnores;
    if (!options?.onlyTriggers && !ignored) return "keep";
    // A body the backend does not index was never masked, so only a trigger-only query rejects it.
    if (!record) return options?.onlyTriggers ? "stop" : "keep";
    const collider = shapeCollider(record, shape);
    // Hits name each shape's owner, so ignoring an actor excludes only its own shapes: a host's shapes, or the shapes
    // hosted for a child.
    const owner = collider?.desc.actorId ?? record.desc.actorId;
    if (ignored?.has(owner)) {
      const before = this.queryMemberships.size;
      for (const owned of this.host.collidersByOwner.get(owner) ?? []) for (const masked of colliderShapes(owned)) this.maskQueryShape(masked);
      return this.queryMemberships.size > before ? "peeled" : "stop";
    }
    if (!options?.onlyTriggers) return "keep";
    if (!collider) return "stop";
    if (collider.desc.isTrigger) return "keep";
    if (this.queryMemberships.has(shape ?? collider.shape)) return "stop";
    for (const owned of colliderShapes(collider)) this.maskQueryShape(owned);
    return "peeled";
  }

  private withQueryFilter<T>(options: LineTraceOptions | undefined, query: () => T): T {
    const memberships = this.queryMemberships;
    // Havok exposes one ignoreBody, but the graph accepts multiple actors. A few ignored shapes (a sweep ignoring its
    // own actor) are masked up front, which costs less than the repeat a peel needs; a long list (a channel's every
    // static or dynamic actor) is masked only as the query reaches each owner (`peelHit`). This synchronous query
    // restores every mask afterwards.
    try {
      const ignored = options?.ignoreActorIds;
      if (ignored?.length && this.ignoredShapeCount(ignored) > EAGER_IGNORED_SHAPES) this.queryIgnores = new Set(ignored);
      else if (ignored) {
        for (const actorId of ignored)
          for (const collider of this.host.collidersByOwner.get(actorId) ?? []) for (const shape of colliderShapes(collider)) this.maskQueryShape(shape);
      }
      if (!queryHitsTriggers(options)) {
        for (const collider of this.host.triggerColliders) this.maskQueryShape(collider.shape);
      }
      return query();
    } finally {
      this.queryIgnores = null;
      try {
        for (const [shape, membership] of memberships) {
          shape.filterMembershipMask = membership;
        }
      } finally {
        memberships.clear();
      }
    }
  }

  /** The shapes the ignored actors own, counted only until it passes `EAGER_IGNORED_SHAPES`. */
  private ignoredShapeCount(actorIds: readonly string[]): number {
    let count = 0;
    for (const actorId of actorIds) {
      for (const collider of this.host.collidersByOwner.get(actorId) ?? []) {
        count += collider.proxy ? 2 : 1;
        if (count > EAGER_IGNORED_SHAPES) return count;
      }
    }
    return count;
  }

  private maskQueryShape(shape: PhysicsShape): void {
    if (this.queryMemberships.has(shape)) return;
    this.queryMemberships.set(shape, shape.filterMembershipMask);
    shape.filterMembershipMask = 0;
  }

  /**
   * Tests the collider shapes, not body bounds: a point proximity query within
   * `radius` finds the closest shape, whose owner's shapes on that body are then
   * excluded until no shape is left in range. Like traces, it names the shape's
   * owner, so a body lists itself and each actor it hosts once; ignored actors
   * are masked once in range and excluded triggers shape by shape. Results keep body order.
   */
  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    this.host.flushMutations();
    const found = new Map<BodyRecord, Set<string>>();
    if ([center.x, center.y, center.z, radius].every(Number.isFinite) && radius >= 0) {
      const query = {
        position: toVector3(center),
        maxDistance: radius,
        collisionFilter: {},
        shouldHitTriggers: queryHitsTriggers(options),
      };
      const result = this.proximityHit;
      this.withQueryFilter(options, () => {
        const memberships = new Map<PhysicsShape, number>();
        try {
          for (;;) {
            this.host.plugin.pointProximity(query, result);
            const bodyId = result.hasHit && result.body ? this.host.bodyIdByPhysicsBody.get(result.body) : undefined;
            const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
            if (!record) break;
            // Ignored actors, and solid shapes for a trigger-only query, are masked as reached, as in `untilAdmitted`.
            const peeled = this.peelHit(options, record, result.shape);
            if (peeled === "stop") break;
            if (peeled === "peeled") continue;
            const owner = shapeOwner(record, result.shape);
            const owners = found.get(record) ?? new Set<string>();
            if (owners.has(owner)) break;
            owners.add(owner);
            found.set(record, owners);
            for (const collider of record.colliders.values()) {
              if ((collider.desc.actorId ?? record.desc.actorId) !== owner) continue;
              for (const shape of colliderShapes(collider)) {
                if (memberships.has(shape)) continue;
                memberships.set(shape, shape.filterMembershipMask);
                shape.filterMembershipMask = 0;
              }
            }
          }
        } finally {
          for (const [shape, membership] of memberships) shape.filterMembershipMask = membership;
        }
      });
    }
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
    // Only the bodies the query found, in body order.
    const records = [...found.keys()].sort((a, b) => a.order - b.order);
    for (const record of records) {
      const owners = found.get(record)!;
      for (const collider of record.colliders.values()) {
        const owner = collider.desc.actorId ?? record.desc.actorId;
        if (!owners.delete(owner)) continue;
        actorIds.push(owner);
        bodyIds.push(record.desc.id);
      }
    }
    return { actorIds, bodyIds };
  }

  shapeSweep(
    shape: ColliderDesc["shape"],
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions,
  ): HitResult {
    this.host.flushMutations();
    const sweep = linearSweepPoses(start, end);
    if (!sweep || !isShape3D(shape)) return miss();
    const reused = this.reusableQueryShape(shape);
    const queryShape = reused ?? createHavokShape(shape, this.host.scene);
    try {
      const rotation = toQuaternion(sweep.start.rotation);
      const from = toVector3(sweep.start.position);
      const to = toVector3(sweep.end);
      const shouldHitTriggers = queryHitsTriggers(options);
      return this.withQueryFilter(options, () => {
        let distance = 0;
        let mayPenetrate = true;
        const found = this.untilAdmitted(options, () => {
          // A cast alone misses shapes the swept shape already penetrates at its start.
          if (mayPenetrate) {
            const proximityInput = this.proximityInput;
            const proximity = this.proximityHit;
            this.host.plugin.shapeProximity(
              { shape: queryShape, position: from, rotation, maxDistance: 0, shouldHitTriggers },
              proximityInput,
              proximity,
            );
            if (proximity.hasHit && proximity.hitDistance < -1e-6) {
              distance = 0;
              return proximity;
            }
            // Masking shapes for a repeat cannot make one penetrate that did not.
            mayPenetrate = false;
          }
          const input = this.castInput;
          const hit = this.castHit;
          this.host.plugin.shapeCast(
            { shape: queryShape, rotation, startPosition: from, endPosition: to, shouldHitTriggers },
            input,
            hit,
          );
          distance = Vector3.Distance(from, to) * hit.hitFraction;
          return hit;
        });
        return found?.hasHit ? this.hitFromCast(found, distance) : miss();
      });
    } finally {
      if (!reused) queryShape.dispose();
    }
  }

  /**
   * The cached native shape for a primitive query shape of these dimensions, created on first use; null for hulls
   * and meshes, whose callers own a fresh shape. A cast only reads the native shape, so repeated sweeps share it.
   * These shapes belong to no collider, so the query filter's masking never reaches them. The set is bounded:
   * the least recently used shape is released when a new size arrives, and `dispose` releases the rest.
   */
  private reusableQueryShape(shape: ColliderShape): PhysicsShape | null {
    let key: string;
    switch (shape.kind) {
      case "box":
        key = `box:${shape.halfExtents.x}:${shape.halfExtents.y}:${shape.halfExtents.z}`;
        break;
      case "sphere":
        key = `sphere:${shape.radius}`;
        break;
      case "capsule":
        key = `capsule:${shape.radius}:${shape.halfHeight}`;
        break;
      case "cylinder":
        key = `cylinder:${shape.radius}:${shape.height}`;
        break;
      default:
        return null;
    }
    // After disposal nothing is kept: the caller builds and releases its own, as for any other shape.
    if (this.host.isDisposed()) return null;
    validateColliderShape(shape);
    const cached = this.queryShapes.get(key);
    if (cached) {
      // Reinserted last: iteration order is recency.
      this.queryShapes.delete(key);
      this.queryShapes.set(key, cached);
      return cached;
    }
    const created = createHavokShape(shape, this.host.scene);
    if (this.queryShapes.size >= QUERY_SHAPE_LIMIT) {
      const [oldest, evicted] = this.queryShapes.entries().next().value!;
      this.queryShapes.delete(oldest);
      evicted.dispose();
    }
    this.queryShapes.set(key, created);
    return created;
  }

  createSphereSweep(radius: number): SphereSweepQuery {
    this.host.flushMutations();
    if (this.host.isDisposed()) throw new Error("Cannot create a sphere sweep on a disposed physics backend");
    if (!Number.isFinite(radius) || radius <= 0) throw new Error("Sphere sweep radius must be finite and positive");
    const shape = new PhysicsShapeSphere(Vector3.Zero(), radius, this.host.scene);
    const start = new Vector3();
    const end = new Vector3();
    const rotation = Quaternion.Identity();
    const cast = { shape, rotation, startPosition: start, endPosition: end, shouldHitTriggers: false };
    const proximity = { shape, rotation, position: start, maxDistance: 0, shouldHitTriggers: false };
    const input = new ShapeCastResult();
    const hit = new ShapeCastResult();
    const proximityInput = new ProximityCastResult();
    const proximityHit = new ProximityCastResult();
    const result = miss();
    const location = { x: 0, y: 0, z: 0 };
    const normal = { x: 0, y: 0, z: 0 };
    let disposed = false;
    const clear = (): HitResult => {
      result.hit = false;
      result.location = null;
      result.normal = null;
      result.distance = 0;
      result.actorId = null;
      result.bodyId = null;
      return result;
    };
    const copyHit = (native: ShapeCastResult | ProximityCastResult, distance: number): HitResult => {
      location.x = native.hitPoint.x; location.y = native.hitPoint.y; location.z = native.hitPoint.z;
      normal.x = native.hitNormal.x; normal.y = native.hitNormal.y; normal.z = native.hitNormal.z;
      result.hit = true;
      result.location = location;
      result.normal = normal;
      result.distance = distance;
      const owner = this.castHitOwner(native);
      result.bodyId = owner.bodyId;
      result.actorId = owner.actorId;
      return result;
    };
    const query: SphereSweepQuery = {
      sweep: (sx, sy, sz, ex, ey, ez) => {
        if (disposed || this.host.isDisposed()) return clear();
        this.host.flushMutations();
        if (disposed || this.host.isDisposed() || !Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) ||
          !Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)) return clear();
        start.set(sx, sy, sz);
        end.set(ex, ey, ez);
        // Casts alone can miss shapes already penetrating at the start, including
        // a stationary particle overlapped by a moving collider.
        this.host.plugin.shapeProximity(proximity, proximityInput, proximityHit);
        if (proximityHit.hasHit && proximityHit.hitDistance < -1e-6) return copyHit(proximityHit, 0);
        this.host.plugin.shapeCast(cast, input, hit);
        if (!hit.hasHit) return clear();
        return copyHit(hit, Math.hypot(ex - sx, ey - sy, ez - sz) * hit.hitFraction);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        shape.dispose();
        this.sphereSweeps.delete(query);
        clear();
      },
    };
    this.sphereSweeps.add(query);
    return query;
  }

  private hitFromCast(native: CastingResult, distance: number): HitResult {
    if (!native.hasHit) return miss();
    const { bodyId, actorId } = this.castHitOwner(native);
    return {
      hit: true,
      location: { x: native.hitPoint.x, y: native.hitPoint.y, z: native.hitPoint.z },
      normal: { x: native.hitNormal.x, y: native.hitNormal.y, z: native.hitNormal.z },
      distance,
      actorId,
      bodyId,
    };
  }

  /**
   * Query hits name the leaf shape inside a compound, so a shape hosted for
   * another actor names that actor, as on software and Rapier.
   */
  private castHitOwner(native: CastingResult): { bodyId: string | null; actorId: string | null } {
    const bodyId = native.body ? (this.host.bodyIdByPhysicsBody.get(native.body) ?? null) : null;
    const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
    if (!bodyId || !record) return { bodyId, actorId: null };
    return { bodyId, actorId: shapeOwner(record, native.shape) };
  }
}
