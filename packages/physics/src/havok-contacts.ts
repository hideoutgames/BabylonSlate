import { PhysicsEventType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import type { ColliderDesc, PhysicsContactEvent } from "./types";
import {
  CONTACT_SHAPE_TIE_TOLERANCE,
  colliderSignedDistance,
  inverseTransformPoint,
  localShapeBounds,
} from "./contact-shape";
import type { BodyRecord, ColliderRecord } from "./havok-records";

/** Identifies a contact within one poll window: the first event of each kind per ordered actor pair wins. */
function contactKey(kind: PhysicsContactEvent["kind"], actorAId: string, actorBId: string): string {
  return `${kind}|${actorAId}|${actorBId}`;
}

function contactDistance(collider: ColliderRecord, x: number, y: number, z: number): number {
  if (collider.bounds === undefined && (collider.desc.shape.kind === "convex" || collider.desc.shape.kind === "mesh"))
    collider.bounds = localShapeBounds(collider.desc.shape);
  return colliderSignedDistance(collider.desc, collider.bounds ?? null, x, y, z);
}

/** What the contact pipeline reads from the backend that owns the world; it never calls back. */
export interface HavokContactHost {
  readonly plugin: HavokPlugin;
  readonly bodies: ReadonlyMap<string, BodyRecord>;
  readonly bodyIdByPhysicsBody: ReadonlyMap<PhysicsBody, string>;
  readonly collidersByOwner: ReadonlyMap<string, ReadonlySet<ColliderRecord>>;
}

/**
 * The Havok backend's contact pipeline: plugin collision and trigger events become actor contact events queued until
 * `poll`, trigger pairs stay open across shape and teleport changes, and reporting changes wait for open overlaps.
 */
export class HavokContacts {
  private readonly host: HavokContactHost;
  /** Contact reporting changes waiting for the body's open trigger overlaps to end (`requestReporting`). */
  private readonly pendingReporting = new Map<BodyRecord, boolean>();
  private readonly removeCollisionObservers: Array<() => void> = [];
  private readonly resetTriggerActors = new Set<string>();
  private pendingContacts: PhysicsContactEvent[] = [];
  /** `contactKey` of each `pendingContacts` entry, index for index. */
  private pendingContactKeys: string[] = [];
  /** The distinct `pendingContactKeys`, so the first-event-wins check is one lookup instead of a scan. */
  private readonly pendingContactKeySet = new Set<string>();
  /** The native bodies each pending hit came from; hits may name hosted actors. */
  private readonly hitBodies = new WeakMap<PhysicsContactEvent, readonly [PhysicsBody, PhysicsBody]>();
  private readonly tmpContactPoint = { x: 0, y: 0, z: 0 };
  private readonly activeTriggerPairs = new Map<
    string,
    {
      actorAId: string;
      actorBId: string;
      /** The begin event's colliders, so every end routes to the same components. */
      colliderAId?: string;
      colliderBId?: string;
      contacts: number;
      /** A teleport dropped the native pair; the next step must re-report it. */
      refreshing: boolean;
    }
  >();

  constructor(host: HavokContactHost) {
    this.host = host;
    this.bindCollisionObservables();
  }

  /** Contacts recorded since the previous poll. */
  poll(): PhysicsContactEvent[] {
    const events = this.pendingContacts;
    this.clearPendingContacts();
    return events;
  }

  /** After the native step: overlap exits naming actors refreshed or retired before it are no longer ignored. */
  nativeStepEnded(): void {
    this.resetTriggerActors.clear();
  }

  /** Retries the reporting changes that waited for open overlaps; a body still in one keeps waiting. */
  applyPendingReporting(): void {
    if (this.pendingReporting.size)
      for (const [record, enabled] of [...this.pendingReporting]) this.requestReporting(record, enabled);
  }

  /** Drops a destroyed body's pending reporting change. */
  forgetBody(record: BodyRecord): void {
    this.pendingReporting.delete(record);
  }

  /** Stops listening to the plugin; `clear` drops the queued state once the world's bodies are disposed. */
  dispose(): void {
    for (const remove of this.removeCollisionObservers) remove();
    this.removeCollisionObservers.length = 0;
  }

  /** Drops every pending contact, open overlap and reporting change. */
  clear(): void {
    this.pendingReporting.clear();
    this.activeTriggerPairs.clear();
    this.clearPendingContacts();
    this.resetTriggerActors.clear();
  }

  /**
   * Changing a native body's event mask while it overlaps a trigger ends that overlap with an exit event the real
   * exit never follows, so a body in an open overlap keeps its mask and changes it once the overlap ends.
   * Hit events carry no state and follow the mask at once.
   */
  requestReporting(record: BodyRecord, enabled: boolean): void {
    if (record.reporting === enabled) {
      this.pendingReporting.delete(record);
      return;
    }
    if (this.inOpenOverlap(record.desc.actorId)) {
      this.pendingReporting.set(record, enabled);
      return;
    }
    this.pendingReporting.delete(record);
    record.reporting = enabled;
    record.body.setCollisionCallbackEnabled(enabled);
  }

  private inOpenOverlap(actorId: string): boolean {
    for (const pair of this.activeTriggerPairs.values()) if (pair.actorAId === actorId || pair.actorBId === actorId) return true;
    return false;
  }

  private bindCollisionObservables(): void {
    const plugin = this.host.plugin;
    const collision = plugin.onCollisionObservable.add((event) => {
      this.recordPluginContact(event, false);
    });
    const trigger = plugin.onTriggerCollisionObservable.add((event) => {
      this.recordPluginContact(event, true);
    });
    this.removeCollisionObservers.push(
      () => plugin.onCollisionObservable.remove(collision),
      () => plugin.onTriggerCollisionObservable.remove(trigger),
    );
  }

  private recordPluginContact(
    raw: unknown,
    fromTriggerObservable: boolean,
  ): void {
    const event = raw as {
      type?: string;
      collider?: PhysicsBody;
      collidedAgainst?: PhysicsBody;
      point?: { x: number; y: number; z: number } | null;
      normal?: { x: number; y: number; z: number } | null;
      /** Separation from `point` (on the collider) to the other body's contact, along `normal`. */
      distance?: number;
    };
    const actorAId = this.actorIdForPhysicsBody(event.collider);
    const actorBId = this.actorIdForPhysicsBody(event.collidedAgainst);
    if (!actorAId || !actorBId || actorAId === actorBId) return;
    const type = String(event.type ?? "");
    let kind: PhysicsContactEvent["kind"] | null = null;
    const isTriggerEvent =
      fromTriggerObservable ||
      type === PhysicsEventType.TRIGGER_ENTERED ||
      type === PhysicsEventType.TRIGGER_EXITED;
    if (isTriggerEvent) {
      // A hosted actor's trigger body would overlap its own shapes on the
      // host, and per-body events cannot tell those from the host's shapes.
      if (
        this.hostsShapesOf(event.collidedAgainst, actorAId) ||
        this.hostsShapesOf(event.collider, actorBId)
      )
        return;
      kind =
        type === PhysicsEventType.TRIGGER_EXITED
          ? "overlapEnd"
          : "overlapBegin";
    } else if (
      type === PhysicsEventType.COLLISION_STARTED ||
      type === PhysicsEventType.COLLISION_CONTINUED ||
      type === ""
    ) {
      kind = "hit";
    }
    if (!kind) return;
    let a = actorAId;
    let b = actorBId;
    let colliderAId: string | undefined;
    let colliderBId: string | undefined;
    if (kind === "hit" && event.point) {
      // Havok reports bodies rather than child shapes. On a compound hosting
      // other actors' shapes, each side's contact point picks the shape it touched.
      const { point, normal } = event;
      const separation = event.distance ?? 0;
      const touchedA = this.touchedCollider(event.collider, point.x, point.y, point.z);
      const touchedB = this.touchedCollider(
        event.collidedAgainst,
        point.x + (normal?.x ?? 0) * separation,
        point.y + (normal?.y ?? 0) * separation,
        point.z + (normal?.z ?? 0) * separation,
      );
      if (touchedA) {
        a = touchedA.actorId ?? actorAId;
        colliderAId = touchedA.id;
      }
      if (touchedB) {
        b = touchedB.actorId ?? actorBId;
        colliderBId = touchedB.id;
      }
      if (a === b) return;
    }
    // Other bodies name their actor's first collider. On a trigger actor route
    // overlap events to its trigger component, even after a blocking collider.
    const swapped = a > b;
    // A hit is not paired, so a repeat of one already pending ends here, before the collider lookups.
    let key: string | undefined;
    if (kind === "hit") {
      key = swapped ? contactKey(kind, b, a) : contactKey(kind, a, b);
      if (this.pendingContactKeySet.has(key)) return;
    }
    colliderAId ??= this.firstColliderIdForActor(a, isTriggerEvent);
    colliderBId ??= this.firstColliderIdForActor(b, isTriggerEvent);
    if (swapped) {
      const swap = a;
      a = b;
      b = swap;
      const swapCollider = colliderAId;
      colliderAId = colliderBId;
      colliderBId = swapCollider;
    }
    if (kind === "overlapBegin" || kind === "overlapEnd") {
      // Havok reports each overlapping child-shape pair. Keep the actor overlap
      // alive until its final shape leaves, including events on later ticks.
      // Length-prefixed, so no pair of IDs can produce another pair's key.
      const pairKey = `${a.length}:${a}${b}`;
      const pair = this.activeTriggerPairs.get(pairKey);
      if (kind === "overlapBegin") {
        if (pair) {
          // Includes a teleported pair re-entering: its overlap never ended.
          pair.contacts += 1;
          pair.refreshing = false;
          return;
        }
        this.activeTriggerPairs.set(pairKey, {
          actorAId: a,
          actorBId: b,
          ...(colliderAId ? { colliderAId } : {}),
          ...(colliderBId ? { colliderBId } : {}),
          contacts: 1,
          refreshing: false,
        });
      } else {
        if (this.resetTriggerActors.has(a) || this.resetTriggerActors.has(b))
          return;
        if (!pair) return;
        pair.contacts -= 1;
        if (pair.contacts > 0) return;
        this.activeTriggerPairs.delete(pairKey);
        // End on the colliders the begin event named.
        colliderAId = pair.colliderAId;
        colliderBId = pair.colliderBId;
      }
    }
    key ??= contactKey(kind, a, b);
    if (this.pendingContactKeySet.has(key)) return;
    const pair = {
      actorAId: a,
      actorBId: b,
      ...(colliderAId ? { colliderAId } : {}),
      ...(colliderBId ? { colliderBId } : {}),
    };
    if (kind !== "hit") {
      this.enqueueContact({ kind, ...pair }, key);
      return;
    }
    const sign = swapped ? -1 : 1;
    const hit: PhysicsContactEvent = {
      kind,
      ...pair,
      location: {
        x: event.point?.x ?? 0,
        y: event.point?.y ?? 0,
        z: event.point?.z ?? 0,
      },
      normal: {
        x: sign * (event.normal?.x ?? 0),
        y: sign * (event.normal?.y ?? 1),
        z: sign * (event.normal?.z ?? 0),
      },
    };
    this.enqueueContact(hit, key);
    if (event.collider && event.collidedAgainst) this.hitBodies.set(hit, [event.collider, event.collidedAgainst]);
  }

  /** Ends an actor overlap with the colliders its begin event named. */
  private pushOverlapEnd(pair: { actorAId: string; actorBId: string; colliderAId?: string; colliderBId?: string }): void {
    // Not deduplicated against pending events, but later events dedup against it.
    this.enqueueContact(
      {
        kind: "overlapEnd",
        actorAId: pair.actorAId,
        actorBId: pair.actorBId,
        ...(pair.colliderAId ? { colliderAId: pair.colliderAId } : {}),
        ...(pair.colliderBId ? { colliderBId: pair.colliderBId } : {}),
      },
      contactKey("overlapEnd", pair.actorAId, pair.actorBId),
    );
  }

  private enqueueContact(event: PhysicsContactEvent, key: string): void {
    this.pendingContacts.push(event);
    this.pendingContactKeys.push(key);
    this.pendingContactKeySet.add(key);
  }

  private clearPendingContacts(): void {
    this.pendingContacts = [];
    this.pendingContactKeys = [];
    this.pendingContactKeySet.clear();
  }

  /** Keeps the pending events `keep` accepts, in order, with the dedup keys of exactly those events. */
  private retainPendingContacts(keep: (event: PhysicsContactEvent) => boolean): void {
    const events: PhysicsContactEvent[] = [];
    const keys: string[] = [];
    this.pendingContactKeySet.clear();
    for (let i = 0; i < this.pendingContacts.length; i++) {
      const event = this.pendingContacts[i]!;
      if (!keep(event)) continue;
      const key = this.pendingContactKeys[i]!;
      events.push(event);
      keys.push(key);
      this.pendingContactKeySet.add(key);
    }
    this.pendingContacts = events;
    this.pendingContactKeys = keys;
  }

  /**
   * The solid collider of a compound hosting other actors' shapes that a
   * contact at world point (x, y, z) touched: the nearest or most deeply
   * containing shape, with ties within `CONTACT_SHAPE_TIE_TOLERANCE` going to
   * the lowest collider ID. Undefined for bodies without hosted shapes, which
   * keep the per-body attribution.
   */
  private touchedCollider(body: PhysicsBody | undefined, x: number, y: number, z: number): ColliderDesc | undefined {
    const bodyId = body ? this.host.bodyIdByPhysicsBody.get(body) : undefined;
    const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
    if (!record?.hostsShapes) return undefined;
    // Hosts are never static, so the node holds the post-step pose synced before callbacks.
    const local = inverseTransformPoint(this.tmpContactPoint, x, y, z, record.node.position, record.node.rotationQuaternion);
    let nearest = Infinity;
    for (const collider of record.colliders.values())
      if (!collider.desc.isTrigger) nearest = Math.min(nearest, contactDistance(collider, local.x, local.y, local.z));
    if (nearest === Infinity) return undefined;
    let touched: ColliderDesc | undefined;
    for (const collider of record.colliders.values()) {
      if (collider.desc.isTrigger || (touched && collider.desc.id > touched.id)) continue;
      if (contactDistance(collider, local.x, local.y, local.z) <= nearest + CONTACT_SHAPE_TIE_TOLERANCE)
        touched = collider.desc;
    }
    return touched;
  }

  private firstColliderIdForActor(
    actorId: string,
    preferTrigger = false,
  ): string | undefined {
    // The owner's colliders in `colliders` map order, which `seq` mirrors: the first one, or with `preferTrigger`
    // the first trigger when it owns any.
    const owned = this.host.collidersByOwner.get(actorId);
    if (!owned) return undefined;
    let first: ColliderRecord | undefined;
    let firstTrigger: ColliderRecord | undefined;
    for (const collider of owned) {
      if (!first || collider.seq < first.seq) first = collider;
      if (preferTrigger && collider.desc.isTrigger && (!firstTrigger || collider.seq < firstTrigger.seq))
        firstTrigger = collider;
    }
    return (firstTrigger ?? first)?.desc.id;
  }

  /** Whether `body`'s compound includes a child shape hosted for `actorId`. */
  private hostsShapesOf(body: PhysicsBody | undefined, actorId: string): boolean {
    const bodyId = body ? this.host.bodyIdByPhysicsBody.get(body) : undefined;
    const record = bodyId ? this.host.bodies.get(bodyId) : undefined;
    if (!record) return false;
    for (const collider of record.colliders.values())
      if (collider.desc.actorId === actorId) return true;
    return false;
  }

  private actorIdForPhysicsBody(body: PhysicsBody | undefined): string | null {
    if (!body) return null;
    const bodyId = this.host.bodyIdByPhysicsBody.get(body);
    if (!bodyId) return null;
    return this.host.bodies.get(bodyId)?.desc.actorId ?? null;
  }

  /**
   * A successful teleport refreshes native world membership, which drops the
   * actor's native pairs without exit callbacks. Its actor-pair overlaps stay
   * open until the next native step: a pair still overlapping re-enters there
   * without a repeated Begin Overlap, and any other pair ends after that step.
   */
  refreshTriggerPairs(record: BodyRecord): void {
    const actorId = record.desc.actorId;
    this.retainPendingContacts(
      (event) => event.kind !== "hit" || !this.pendingHitInvolves(event, record),
    );
    for (const pair of this.activeTriggerPairs.values()) {
      if (pair.actorAId !== actorId && pair.actorBId !== actorId) continue;
      pair.contacts = 0;
      pair.refreshing = true;
    }
    this.resetTriggerActors.add(actorId);
  }

  /** Whether a pending hit came from `record`'s body, including hits naming actors it hosts. */
  private pendingHitInvolves(event: PhysicsContactEvent, record: BodyRecord): boolean {
    const bodies = this.hitBodies.get(event);
    if (bodies) return bodies[0] === record.body || bodies[1] === record.body;
    return event.actorAId === record.desc.actorId || event.actorBId === record.desc.actorId;
  }

  endUnconfirmedTriggerPairs(): void {
    for (const [key, pair] of this.activeTriggerPairs) {
      if (!pair.refreshing) continue;
      this.activeTriggerPairs.delete(key);
      this.pushOverlapEnd(pair);
    }
  }

  retireTriggerPairs(record: BodyRecord): void {
    const actorId = record.desc.actorId;
    this.retainPendingContacts(
      (event) =>
        event.kind === "overlapEnd" ||
        (event.kind === "hit"
          ? !this.pendingHitInvolves(event, record)
          : event.actorAId !== actorId && event.actorBId !== actorId),
    );
    for (const [key, pair] of this.activeTriggerPairs) {
      if (pair.actorAId !== actorId && pair.actorBId !== actorId) continue;
      this.activeTriggerPairs.delete(key);
      this.pushOverlapEnd(pair);
    }
    this.resetTriggerActors.add(actorId);
  }
}
