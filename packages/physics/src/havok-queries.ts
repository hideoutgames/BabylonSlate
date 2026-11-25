import type {
  ContactPoint,
  HavokPhysicsWithBindings,
  HP_CollectorId,
  HP_ShapeId,
  HP_WorldId,
} from "@babylonjs/havok";
import type { SphereSweepQuery } from "./backend";
import type {
  ColliderDesc,
  ColliderShape,
  HitResult,
  LineTraceOptions,
  OverlapResult,
  PhysicsTransform,
  Vec3,
} from "./types";
import { linearSweepPoses, validateColliderShape } from "./collider-validation";
import { ownIgnoredActors, queryHitsTriggers } from "./query-filter";
import {
  createHavokShape,
  isShape3D,
  releaseHavokShape,
  setShapeFilterMasks,
  type BodyRecord,
  type ColliderRecord,
} from "./havok-records";
import {
  checked,
  checkedValue,
  IDENTITY_HAVOK_QUAT,
  NULL_BODY_ID,
  toHavokQuat,
  toHavokVec3,
  ZERO_HAVOK_VEC3,
} from "./havok-wasm-memory";

/** Native shapes `shapeSweep` keeps for reuse; a script sweeping ever-changing sizes churns within this bound. */
const QUERY_SHAPE_LIMIT = 16;
/** Ignored shapes a query masks up front; past this, each ignored owner is masked only once the query reaches it. */
const EAGER_IGNORED_SHAPES = 16;
const ALL_FILTER: [number, number] = [0xffffffff, 0xffffffff];

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

type NativeHit = {
  hasHit: boolean;
  bodyHpId: bigint;
  shapeHpId: bigint;
  px: number;
  py: number;
  pz: number;
  nx: number;
  ny: number;
  nz: number;
  fraction: number;
  distance: number;
};

function clearNativeHit(hit: NativeHit): NativeHit {
  hit.hasHit = false;
  hit.bodyHpId = 0n;
  hit.shapeHpId = 0n;
  hit.px = 0; hit.py = 0; hit.pz = 0;
  hit.nx = 0; hit.ny = 0; hit.nz = 0;
  hit.fraction = 0;
  hit.distance = 0;
  return hit;
}

function fillContactPoint(hit: NativeHit, cp: ContactPoint, fraction: number, distance: number): NativeHit {
  hit.hasHit = true;
  hit.bodyHpId = cp[0][0];
  hit.shapeHpId = cp[1][0];
  hit.px = cp[3][0];
  hit.py = cp[3][1];
  hit.pz = cp[3][2];
  hit.nx = cp[4][0];
  hit.ny = cp[4][1];
  hit.nz = cp[4][2];
  hit.fraction = fraction;
  hit.distance = distance;
  return hit;
}

function shapeOwner(record: BodyRecord, shapeHpId: bigint): string {
  return shapeCollider(record, shapeHpId)?.desc.actorId ?? record.desc.actorId;
}

/** The collider a query hit named on this body; undefined when it names none and the body has several. */
function shapeCollider(record: BodyRecord, shapeHpId: bigint): ColliderRecord | undefined {
  if (shapeHpId !== 0n) {
    for (const collider of record.colliders.values()) {
      if (collider.shape[0] === shapeHpId || collider.proxy?.[0] === shapeHpId) return collider;
    }
  }
  // Havok reports no child shape for a body with a single collider.
  return record.colliders.size === 1 ? record.colliders.values().next().value : undefined;
}

/** What the queries read from the backend that owns the world. */
export interface HavokQueryHost {
  readonly havok: HavokPhysicsWithBindings;
  readonly worldId: HP_WorldId;
  readonly bodies: ReadonlyMap<string, BodyRecord>;
  readonly bodyIdByHpId: ReadonlyMap<number, string>;
  readonly collidersByOwner: ReadonlyMap<string, ReadonlySet<ColliderRecord>>;
  readonly triggerColliders: ReadonlySet<ColliderRecord>;
  isDisposed(): boolean;
  assertUsable(): void;
}

/**
 * The Havok backend's direct script queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, sphere sweeps) over
 * `HP_QueryCollector_*` and `HP_World_*WithCollector`, with per-query filtering that masks excluded shapes and
 * restores them before returning.
 */
export class HavokQueries {
  private readonly host: HavokQueryHost;
  private readonly collector: HP_CollectorId;
  /** Shapes a running query filter masked and their cached `[membership, collide]` masks; empty between queries. */
  private readonly queryMemberships = new Map<HP_ShapeId, { membership: number; collide: number }>();
  private peelingIgnores = false;
  private queryIgnoredOwn: ReadonlySet<string> | null = null;
  private queryIgnoredSet: ReadonlySet<string> | null = null;
  private readonly sphereSweeps = new Set<SphereSweepQuery>();
  /** Native shapes for primitive `shapeSweep` casts by kind and dimensions, least recently used first. */
  private readonly queryShapes = new Map<string, HP_ShapeId>();
  private readonly hitScratch: NativeHit = {
    hasHit: false,
    bodyHpId: 0n,
    shapeHpId: 0n,
    px: 0, py: 0, pz: 0,
    nx: 0, ny: 0, nz: 0,
    fraction: 0,
    distance: 0,
  };

  constructor(host: HavokQueryHost) {
    this.host = host;
    this.collector = checkedValue(
      host.havok,
      host.havok.HP_QueryCollector_Create(1),
      "query collector creation",
    );
  }

  /** Releases the collector, sphere sweeps, and cached query shapes. */
  dispose(): void {
    for (const query of this.sphereSweeps) query.dispose();
    for (const shape of this.queryShapes.values()) releaseHavokShape(this.host.havok, shape);
    this.queryShapes.clear();
    if (this.collector[0] !== 0n) {
      this.host.havok.HP_QueryCollector_Release(this.collector);
    }
  }

  lineTrace(start: Vec3, end: Vec3, options?: LineTraceOptions): HitResult {
    this.host.assertUsable();
    if (this.host.isDisposed()) return miss();
    const havok = this.host.havok;
    const worldId = this.host.worldId;
    const from = toHavokVec3(start);
    const to = toHavokVec3(end);
    return this.withQueryFilter(options, () => {
      const shouldHitTriggers = queryHitsTriggers(options);
      const hit = this.untilAdmitted(options, () => {
        clearNativeHit(this.hitScratch);
        checked(
          havok,
          havok.HP_World_CastRayWithCollector(worldId, this.collector, [
            from,
            to,
            ALL_FILTER,
            shouldHitTriggers,
            NULL_BODY_ID,
          ]),
          "raycast",
        );
        const numHits = checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "raycast hit count");
        if (numHits <= 0) return this.hitScratch;
        const [fraction, cp] = checkedValue(
          havok,
          havok.HP_QueryCollector_GetCastRayResult(this.collector, 0),
          "raycast result",
        );
        const dist = Math.hypot(cp[3][0] - start.x, cp[3][1] - start.y, cp[3][2] - start.z);
        return fillContactPoint(this.hitScratch, cp, fraction, dist);
      });
      if (!hit?.hasHit) return miss();
      return this.hitFromNative(hit, hit.distance);
    });
  }

  /**
   * Runs `find`, one native query, and returns its hit, peeling ignored actors, excluded triggers, or non-trigger shapes on demand.
   */
  private untilAdmitted(options: LineTraceOptions | undefined, find: () => NativeHit): NativeHit | null {
    const excludeTriggers = !queryHitsTriggers(options) && this.host.triggerColliders.size > 0;
    for (;;) {
      const result = find();
      if ((!options?.onlyTriggers && !this.peelingIgnores && !excludeTriggers) || !result.hasHit) return result;
      const bodyId = this.host.bodyIdByHpId.get(Number(result.bodyHpId));
      const peeled = this.peelHit(options, bodyId ? this.host.bodies.get(bodyId) : undefined, result.shapeHpId);
      if (peeled === "keep") return result;
      if (peeled === "stop") return null;
    }
  }

  private peelHit(
    options: LineTraceOptions | undefined,
    record: BodyRecord | undefined,
    shapeHpId: bigint,
  ): "keep" | "peeled" | "stop" {
    const ignoring = this.peelingIgnores;
    const excludeTriggers = !queryHitsTriggers(options);
    if (!options?.onlyTriggers && !ignoring && !excludeTriggers) return "keep";
    if (!record) return options?.onlyTriggers ? "stop" : "keep";
    const collider = shapeCollider(record, shapeHpId);
    const owner = collider?.desc.actorId ?? record.desc.actorId;
    if (ignoring && (this.queryIgnoredOwn?.has(owner) === true || this.queryIgnoredSet?.has(owner) === true)) {
      const before = this.queryMemberships.size;
      for (const owned of this.host.collidersByOwner.get(owner) ?? []) {
        this.maskColliderShapes(owned);
      }
      return this.queryMemberships.size > before ? "peeled" : "stop";
    }
    // Safety net if any Havok collector returns a trigger or overlap proxy despite `shouldHitTriggers = false`.
    if (excludeTriggers && collider && (collider.desc.isTrigger || (collider.proxy !== undefined && collider.proxy[0] === shapeHpId))) {
      const before = this.queryMemberships.size;
      this.maskColliderShapes(collider);
      return this.queryMemberships.size > before ? "peeled" : "stop";
    }
    if (!options?.onlyTriggers) return "keep";
    if (!collider) return "stop";
    if (collider.desc.isTrigger) return "keep";
    const alreadyMasked =
      (shapeHpId !== 0n && [...this.queryMemberships.keys()].some((s) => s[0] === shapeHpId)) ||
      this.queryMemberships.has(collider.shape);
    if (alreadyMasked) return "stop";
    this.maskColliderShapes(collider);
    return "peeled";
  }

  private withQueryFilter<T>(options: LineTraceOptions | undefined, query: () => T): T {
    const memberships = this.queryMemberships;
    try {
      const own = options?.ignoreActorIds, kept = options?.ignoreActorSet;
      if ((own?.length || kept?.size) && this.ignoredShapeCount(own, kept) > EAGER_IGNORED_SHAPES) {
        this.peelingIgnores = true;
        this.queryIgnoredOwn = ownIgnoredActors(options);
        this.queryIgnoredSet = kept ?? null;
      } else {
        if (own) for (const actorId of own) this.maskOwnerShapes(actorId);
        if (kept) for (const actorId of kept) this.maskOwnerShapes(actorId);
      }
      return query();
    } finally {
      this.peelingIgnores = false;
      this.queryIgnoredOwn = null;
      this.queryIgnoredSet = null;
      try {
        for (const [shape, saved] of memberships) {
          setShapeFilterMasks(this.host.havok, shape, saved.membership, saved.collide);
        }
      } finally {
        memberships.clear();
      }
    }
  }

  private ignoredShapeCount(own: readonly string[] | undefined, kept: ReadonlySet<string> | undefined): number {
    let count = 0;
    if (own) for (const actorId of own) {
      count = this.countOwnerShapes(actorId, count);
      if (count > EAGER_IGNORED_SHAPES) return count;
    }
    if (kept) for (const actorId of kept) {
      count = this.countOwnerShapes(actorId, count);
      if (count > EAGER_IGNORED_SHAPES) return count;
    }
    return count;
  }

  private countOwnerShapes(actorId: string, count: number): number {
    for (const collider of this.host.collidersByOwner.get(actorId) ?? []) {
      count += collider.proxy ? 2 : 1;
      if (count > EAGER_IGNORED_SHAPES) return count;
    }
    return count;
  }

  private maskOwnerShapes(actorId: string): void {
    for (const collider of this.host.collidersByOwner.get(actorId) ?? []) {
      this.maskColliderShapes(collider);
    }
  }

  private maskColliderShapes(collider: ColliderRecord): void {
    this.maskQueryShape(collider.shape, collider.membershipMask, collider.collideMask);
    if (collider.proxy) this.maskQueryShape(collider.proxy, collider.membershipMask, collider.proxyCollideMask);
  }

  private maskQueryShape(shape: HP_ShapeId, membership: number, collide: number): void {
    if (this.queryMemberships.has(shape)) return;
    setShapeFilterMasks(this.host.havok, shape, 0, collide);
    this.queryMemberships.set(shape, { membership, collide });
  }

  sphereOverlap(center: Vec3, radius: number, options?: LineTraceOptions): OverlapResult {
    this.host.assertUsable();
    const found = new Map<BodyRecord, Set<string>>();
    if (!this.host.isDisposed() && [center.x, center.y, center.z, radius].every(Number.isFinite) && radius >= 0) {
      const havok = this.host.havok;
      const worldId = this.host.worldId;
      const centerVec = toHavokVec3(center);
      const shouldHitTriggers = queryHitsTriggers(options);
      this.withQueryFilter(options, () => {
        const memberships = new Map<HP_ShapeId, { membership: number; collide: number }>();
        try {
          for (;;) {
            checked(
              havok,
              havok.HP_World_PointProximityWithCollector(worldId, this.collector, [
                centerVec,
                radius,
                ALL_FILTER,
                shouldHitTriggers,
                NULL_BODY_ID,
              ]),
              "point proximity",
            );
            const numHits = checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "proximity hit count");
            if (numHits <= 0) break;
            const [, cp] = checkedValue(
              havok,
              havok.HP_QueryCollector_GetPointProximityResult(this.collector, 0),
              "point proximity result",
            );
            const bodyId = this.host.bodyIdByHpId.get(Number(cp[0][0]));
            const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
            if (!record) break;
            const hitShapeId = cp[1][0];
            const peeled = this.peelHit(options, record, hitShapeId);
            if (peeled === "stop") break;
            if (peeled === "peeled") continue;
            const owner = shapeOwner(record, hitShapeId);
            const owners = found.get(record) ?? new Set<string>();
            if (owners.has(owner)) break;
            owners.add(owner);
            found.set(record, owners);
            for (const collider of record.colliders.values()) {
              if ((collider.desc.actorId ?? record.desc.actorId) !== owner) continue;
              if (!memberships.has(collider.shape)) {
                setShapeFilterMasks(havok, collider.shape, 0, collider.collideMask);
                memberships.set(collider.shape, { membership: collider.membershipMask, collide: collider.collideMask });
              }
              if (collider.proxy && !memberships.has(collider.proxy)) {
                setShapeFilterMasks(havok, collider.proxy, 0, collider.proxyCollideMask);
                memberships.set(collider.proxy, { membership: collider.membershipMask, collide: collider.proxyCollideMask });
              }
            }
          }
        } finally {
          for (const [shape, saved] of memberships) {
            setShapeFilterMasks(havok, shape, saved.membership, saved.collide);
          }
        }
      });
    }
    const actorIds: string[] = [];
    const bodyIds: string[] = [];
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
    this.host.assertUsable();
    if (this.host.isDisposed()) return miss();
    const sweep = linearSweepPoses(start, end);
    if (!sweep || !isShape3D(shape)) return miss();
    const havok = this.host.havok;
    const worldId = this.host.worldId;
    const reused = this.reusableQueryShape(shape);
    const queryShape = reused ?? createHavokShape(havok, shape);
    try {
      const rotation = toHavokQuat(sweep.start.rotation);
      const from = toHavokVec3(sweep.start.position);
      const to = toHavokVec3(sweep.end);
      const castLength = Math.hypot(
        sweep.end.x - sweep.start.position.x,
        sweep.end.y - sweep.start.position.y,
        sweep.end.z - sweep.start.position.z,
      );
      const shouldHitTriggers = queryHitsTriggers(options);
      return this.withQueryFilter(options, () => {
        let distance = 0;
        let mayPenetrate = true;
        const found = this.untilAdmitted(options, () => {
          clearNativeHit(this.hitScratch);
          // A cast alone misses shapes the swept shape already penetrates at its start.
          if (mayPenetrate) {
            checked(
              havok,
              havok.HP_World_ShapeProximityWithCollector(worldId, this.collector, [
                queryShape,
                from,
                rotation,
                0,
                shouldHitTriggers,
                NULL_BODY_ID,
              ]),
              "shape proximity",
            );
            const proxHits = checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "shape proximity count");
            if (proxHits > 0) {
              const [proxDist, , hitWorld] = checkedValue(
                havok,
                havok.HP_QueryCollector_GetShapeProximityResult(this.collector, 0),
                "shape proximity result",
              );
              if (proxDist < -1e-6) {
                distance = 0;
                return fillContactPoint(this.hitScratch, hitWorld, 0, proxDist);
              }
            }
            mayPenetrate = false;
          }
          checked(
            havok,
            havok.HP_World_ShapeCastWithCollector(worldId, this.collector, [
              queryShape,
              rotation,
              from,
              to,
              shouldHitTriggers,
              NULL_BODY_ID,
            ]),
            "shape cast",
          );
          const castHits = checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "shape cast count");
          if (castHits <= 0) {
            distance = 0;
            return this.hitScratch;
          }
          const [fraction, , hitWorld] = checkedValue(
            havok,
            havok.HP_QueryCollector_GetShapeCastResult(this.collector, 0),
            "shape cast result",
          );
          distance = castLength * fraction;
          return fillContactPoint(this.hitScratch, hitWorld, fraction, distance);
        });
        return found?.hasHit ? this.hitFromNative(found, distance) : miss();
      });
    } finally {
      if (!reused) releaseHavokShape(havok, queryShape);
    }
  }

  private reusableQueryShape(shape: ColliderShape): HP_ShapeId | null {
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
    if (this.host.isDisposed()) return null;
    validateColliderShape(shape);
    const cached = this.queryShapes.get(key);
    if (cached) {
      this.queryShapes.delete(key);
      this.queryShapes.set(key, cached);
      return cached;
    }
    const created = createHavokShape(this.host.havok, shape);
    if (this.queryShapes.size >= QUERY_SHAPE_LIMIT) {
      const [oldest, evicted] = this.queryShapes.entries().next().value!;
      this.queryShapes.delete(oldest);
      releaseHavokShape(this.host.havok, evicted);
    }
    this.queryShapes.set(key, created);
    return created;
  }

  createSphereSweep(radius: number): SphereSweepQuery {
    this.host.assertUsable();
    if (this.host.isDisposed()) throw new Error("Cannot create a sphere sweep on a disposed physics backend");
    if (!Number.isFinite(radius) || radius <= 0) throw new Error("Sphere sweep radius must be finite and positive");
    const havok = this.host.havok;
    const worldId = this.host.worldId;
    const shape = checkedValue(
      havok,
      havok.HP_Shape_CreateSphere(ZERO_HAVOK_VEC3, radius),
      "sphere sweep shape creation",
    );
    const result = miss();
    const location = { x: 0, y: 0, z: 0 };
    const normal = { x: 0, y: 0, z: 0 };
    const startVec: [number, number, number] = [0, 0, 0];
    const endVec: [number, number, number] = [0, 0, 0];
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

    const copyHit = (cp: ContactPoint, distance: number): HitResult => {
      location.x = cp[3][0]; location.y = cp[3][1]; location.z = cp[3][2];
      normal.x = cp[4][0]; normal.y = cp[4][1]; normal.z = cp[4][2];
      result.hit = true;
      result.location = location;
      result.normal = normal;
      result.distance = distance;
      const owner = this.castHitOwner(cp[0][0], cp[1][0]);
      result.bodyId = owner.bodyId;
      result.actorId = owner.actorId;
      return result;
    };

    const query: SphereSweepQuery = {
      sweep: (sx, sy, sz, ex, ey, ez) => {
        if (disposed || this.host.isDisposed()) return clear();
        this.host.assertUsable();
        if (
          disposed ||
          this.host.isDisposed() ||
          !Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) ||
          !Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(ez)
        ) {
          return clear();
        }
        startVec[0] = sx; startVec[1] = sy; startVec[2] = sz;
        endVec[0] = ex; endVec[1] = ey; endVec[2] = ez;
        checked(
          havok,
          havok.HP_World_ShapeProximityWithCollector(worldId, this.collector, [
            shape,
            startVec,
            IDENTITY_HAVOK_QUAT,
            0,
            false,
            NULL_BODY_ID,
          ]),
          "sphere sweep proximity",
        );
        if (checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "sphere sweep proximity count") > 0) {
          const [proxDist, , hitWorld] = checkedValue(
            havok,
            havok.HP_QueryCollector_GetShapeProximityResult(this.collector, 0),
            "sphere sweep proximity result",
          );
          if (proxDist < -1e-6) return copyHit(hitWorld, 0);
        }
        checked(
          havok,
          havok.HP_World_ShapeCastWithCollector(worldId, this.collector, [
            shape,
            IDENTITY_HAVOK_QUAT,
            startVec,
            endVec,
            false,
            NULL_BODY_ID,
          ]),
          "sphere sweep cast",
        );
        if (checkedValue(havok, havok.HP_QueryCollector_GetNumHits(this.collector), "sphere sweep cast count") <= 0) {
          return clear();
        }
        const [fraction, , hitWorld] = checkedValue(
          havok,
          havok.HP_QueryCollector_GetShapeCastResult(this.collector, 0),
          "sphere sweep cast result",
        );
        return copyHit(hitWorld, Math.hypot(ex - sx, ey - sy, ez - sz) * fraction);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        releaseHavokShape(havok, shape);
        this.sphereSweeps.delete(query);
        clear();
      },
    };
    this.sphereSweeps.add(query);
    return query;
  }

  private hitFromNative(hit: NativeHit, distance: number): HitResult {
    if (!hit.hasHit) return miss();
    const { bodyId, actorId } = this.castHitOwner(hit.bodyHpId, hit.shapeHpId);
    return {
      hit: true,
      location: { x: hit.px, y: hit.py, z: hit.pz },
      normal: { x: hit.nx, y: hit.ny, z: hit.nz },
      distance,
      actorId,
      bodyId,
    };
  }

  private castHitOwner(bodyHpId: bigint, shapeHpId: bigint): { bodyId: string | null; actorId: string | null } {
    const bodyId = this.host.bodyIdByHpId.get(Number(bodyHpId)) ?? null;
    const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
    if (!bodyId || !record) return { bodyId, actorId: null };
    return { bodyId, actorId: shapeOwner(record, shapeHpId) };
  }
}
