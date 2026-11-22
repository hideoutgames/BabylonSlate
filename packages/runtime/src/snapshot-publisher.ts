import {
  SNAPSHOT_ACTOR_STRIDE,
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  SNAPSHOT_HEADER_FLOATS,
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type ActorSlot,
  type CommandMessage,
} from "@haptic/bridge";
import { isSceneLayerAnchorActor, type Transform } from "@haptic/core";
import type { Actor, World, WorldChangeObserver } from "@haptic/object-model";
import { actorLabel, WorldTransformComposer, type ActorTransformMap } from "./actor-world-transform";
import type { LogSeverity } from "./log-ring";
import type { RenderSlotObserver, RenderSlots } from "./render-slots";
import type { RuntimeDiagnosticRecorder } from "./runtime-diagnostic-recorder";

interface SnapshotPublisherHost {
  stopped(): boolean;
  frameId(): number;
  lastScriptMs(): number;
  lastPhysicsMs(): number;
  /** The main Scene may tick or a SceneLayer is ready: a tick reaches its publish point. */
  canPublish(): boolean;
  /** The actor the Play camera follows; its position moves the floating origin. */
  cameraActor(): Actor | null;
  /** The main Scene's Layer Camera centre, which the floating origin follows while no camera actor is in view. */
  layerCameraCentre(): { x: number; y: number } | null;
  applyOverlayLayouts(): void;
  retireDetachedStreams(): void;
  /** The removal pass despawned at least one actor. */
  removedActors(): void;
  recorder(): RuntimeDiagnosticRecorder | null;
  /** Publish time spent in the current tick while a profile records. */
  profilePublish(milliseconds: number): void;
  reportLog(message: string, severity: LogSeverity, category: string): void;
  reportError(error: unknown): void;
  emit(command: CommandMessage): void;
}

/**
 * The Actor pose snapshot: seq-locked double buffer, capacity growth
 * (`snapshotLayout`), the floating origin, and publishing. A publish lays out
 * overlays and runs the removal pass, then composes changed world poses and
 * writes updated actor slots across the 2-buffer pair. `advance()` catch-up
 * ticks keep their per-tick layout and removals but write only the burst's
 * final frame. Spawns, destroys, reparents, component and Scene Layer changes
 * and slot table changes arrive as `WorldChangeObserver` and
 * `RenderSlotObserver` notifications, so a publish works only on the actors
 * they name; rows stay in spawn order, as a pass over the World writes them.
 */
export class SnapshotPublisher {
  private snapshots: SeqLockSnapshotPair;
  private _generation = 0;
  /** Publish-time world poses, updated incrementally from `WorldChangeObserver` notifications. */
  private readonly poses = new WorldTransformComposer();
  private readonly findActor: (guid: string) => Actor | undefined;
  /** Reused per actor while writing a snapshot; `writeActorSlot` copies it into the buffer. */
  private readonly slot: ActorSlot = {
    slotId: 0,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    flags: 0,
  };
  private origin = { x: 0, y: 0, z: 0 };
  private originGeneration = 0;
  /** Incremental snapshot state across the 2-buffer `SeqLockSnapshotPair`. */
  private fullRewriteRemaining = 2;
  private needsFullCompose = true;
  private lastStructureRevision = -1;
  private lastSlotsRevision = -1;
  private lastOriginGeneration = -1;
  private lastCapacity = -1;
  /** The actor each written row holds, in row order: ascending `spawnOrder`, the World's actor order. */
  private readonly rowActors: Actor[] = [];
  /** Actors whose row may appear, leave or change slot or flags: spawns, destroys, slot, anchor and layer changes. */
  private readonly rowCandidates = new Set<Actor>();
  /** The last write moved, added or removed rows, so the other buffer lacks that layout. */
  private backStale = false;
  private readonly dirtyPoses = new Set<Actor>();
  /** Destroyed actors whose guid's pose leaves the composer unless a successor holds the guid. */
  private readonly departedPoses = new Set<Actor>();
  private readonly dirtySlotFrames = new Map<Actor, number>();
  /** Reused by every descendant walk. */
  private readonly walkStack: Actor[] = [];
  /** Reused scratch: dirty actors in World order, removed row indices and inserted actors. */
  private readonly composeOrder: Actor[] = [];
  private readonly removedRows: number[] = [];
  private readonly insertedRows: Actor[] = [];
  private readonly unsubscribeWorld: () => void;
  private readonly unsubscribeSlots: () => void;
  /** Actors whose sheared world pose has been reported to the Output Log. */
  private readonly shearedActors = new WeakSet<Actor>();
  private readonly reportShearedActor = (actor: Actor): void => {
    if (this.shearedActors.has(actor)) return;
    this.shearedActors.add(actor);
    this.host.reportLog(
      `${actorLabel(actor)} has a sheared world transform (nonuniform parent scale with an oblique rotation). ` +
        "Play shows its nearest rotation and scale; attached actors keep their exact positions.",
      "warning",
      "actor",
    );
  };
  /** Most recent publish: overlay layout and removal pass, composition and buffer write. */
  private _lastPublishMs = 0;
  /** Publish milliseconds summed since `takeMeanPublishMs` last read them, and the publishes they cover. */
  private publishSumMs = 0;
  private publishCount = 0;
  /** Completed snapshot writes; unchanged while nothing (a tick, an edit, a realization) wrote a newer pose. */
  private _writes = 0;
  /** True while `advance()` runs catch-up ticks; their snapshot writes wait for the burst to end. */
  private deferring = false;
  /** Header of the last tick that reached its publish point while writes were deferred. */
  private readonly pendingHeader = { frameId: 0, tickIndex: 0, scriptMs: 0, physicsMs: 0 };
  private writePending = false;
  /** Removal-pass time already spent on the pending publish. */
  private pendingPublishMs = 0;
  /** The first removal pass checks every slot; later ones check only `slotChecks` and the watched slots. */
  private fullSlotPass = true;
  /** Slots whose owner may have left: allocated since the last pass, or owned by a destroyed actor. */
  private readonly slotChecks = new Set<number>();
  /** Slots the last pass kept for a spawn-queued owner: a cancelled spawn leaves without a notification. */
  private readonly queuedSlots = new Set<number>();
  /** Earlier slots of an actor that was allocated another: its destroy names only the newest. */
  private readonly shadowedSlots = new Set<number>();
  /** Reused by each removal pass. */
  private readonly retiring: number[] = [];
  private readonly byAllocation = (a: number, b: number): number =>
    this.slots.allocationNumber(a) - this.slots.allocationNumber(b);
  private readonly world: World;
  private readonly slots: RenderSlots;
  private readonly host: SnapshotPublisherHost;
  private readonly now: () => number;

  /** Until the first full pass every pose and row is rebuilt, so nothing is collected. */
  private readonly worldObserver: WorldChangeObserver = {
    onActorSpawned: (actor) => {
      if (this.needsFullCompose) return;
      this.rowCandidates.add(actor);
      // Children spawned earlier under its guid now compose under it.
      this.markPoseDirtyWithDescendants(actor);
    },
    onActorDestroyed: (actor) => {
      const slotId = this.slots.actorSlot(actor);
      if (slotId !== undefined) this.slotChecks.add(slotId);
      if (this.needsFullCompose) return;
      this.rowCandidates.add(actor);
      this.departedPoses.add(actor);
      // Its children now compose as roots.
      const children = this.world.getChildren(actor.guid);
      if (children) {
        for (const child of children) {
          if (!child.destroyed) this.markPoseDirtyWithDescendants(child);
        }
      }
    },
    onActorParentChanged: (actor) => {
      if (this.needsFullCompose) return;
      this.markPoseDirtyWithDescendants(actor);
    },
    onActorTransformChanged: (actor) => {
      if (this.needsFullCompose) return;
      this.markPoseDirtyWithDescendants(actor);
    },
    onActorVariableChanged: (actor, name) => {
      if (name === "visible" || name === null) {
        this.dirtySlotFrames.set(actor, 2);
      }
    },
    onActorComponentChanged: (actor, _component, kind) => {
      // Attaching or destroying a component can make an actor anchor-only, which has no row.
      if (this.needsFullCompose || (kind !== "attached" && kind !== "destroyed")) return;
      this.rowCandidates.add(actor);
    },
    onActorLayerChanged: (actor) => {
      // The row's overlay flag.
      if (this.needsFullCompose) return;
      this.rowCandidates.add(actor);
    },
  };

  private readonly slotObserver: RenderSlotObserver = {
    onSlotAllocated: (slotId, actor, previous) => {
      this.slotChecks.add(slotId);
      if (previous !== undefined) this.shadowedSlots.add(previous);
      if (!this.needsFullCompose) this.rowCandidates.add(actor);
    },
    onSlotReleased: (slotId, owner) => {
      this.slotChecks.delete(slotId);
      this.queuedSlots.delete(slotId);
      this.shadowedSlots.delete(slotId);
      if (owner && !this.needsFullCompose) this.rowCandidates.add(owner);
    },
  };

  constructor(maxActors: number, world: World, slots: RenderSlots, host: SnapshotPublisherHost, now: () => number) {
    this.snapshots = SeqLockSnapshotPair.create(maxActors);
    this.world = world;
    this.slots = slots;
    this.host = host;
    this.now = now;
    this.findActor = (guid) => world.findActor(guid);
    this.unsubscribeWorld = world.addChangeObserver(this.worldObserver);
    this.unsubscribeSlots = slots.addObserver(this.slotObserver);
  }

  dispose(): void {
    this.unsubscribeWorld();
    this.unsubscribeSlots();
    this.dirtyPoses.clear();
    this.departedPoses.clear();
    this.dirtySlotFrames.clear();
    this.rowCandidates.clear();
    this.rowActors.length = 0;
    this.slotChecks.clear();
    this.queuedSlots.clear();
    this.shadowedSlots.clear();
    this.walkStack.length = 0;
    this.composeOrder.length = 0;
  }

  get capacity(): number { return this.snapshots.maxActors; }
  get generation(): number { return this._generation; }
  get lastPublishMs(): number { return this._lastPublishMs; }

  /**
   * The mean publish milliseconds since the previous call (the stats command's `publishMs`), then a fresh window; the
   * last publish's when none happened since. A mean shows the fractions a clock in whole milliseconds hides.
   */
  takeMeanPublishMs(): number {
    if (!this.publishCount) return this._lastPublishMs;
    const mean = this.publishSumMs / this.publishCount;
    this.publishSumMs = 0;
    this.publishCount = 0;
    return mean;
  }
  get writes(): number { return this._writes; }

  /** Grow the buffers to hold `required` slots and announce the new layout, or report and throw. */
  ensureCapacity(required: number): void {
    if (required <= this.snapshots.maxActors) return;
    let capacity = Math.max(1, this.snapshots.maxActors);
    while (capacity < required) capacity *= 2;
    try {
      this.snapshots = SeqLockSnapshotPair.grow(this.snapshots, capacity);
      this._generation += 1;
      this.fullRewriteRemaining = 2;
      this.host.emit({ type: "snapshotLayout", capacity, generation: this._generation });
    } catch (error) {
      const message = `Unable to grow Actor snapshot capacity to ${capacity}: ${error instanceof Error ? error.message : String(error)}`;
      this.host.reportError(new Error(message, { cause: error }));
      throw new Error(message, { cause: error });
    }
  }

  /** Copy the latest complete snapshot; false when `out` is too small or a write raced every retry. */
  copy(out: Float32Array): boolean {
    if (out.length < this.snapshots.floatCount) return false;
    return this.snapshots.tryRead(out);
  }

  /**
   * Run `advance()` catch-up ticks with snapshot writes deferred; the outermost
   * call writes the burst's final frame unless a tick threw.
   */
  deferWrites(run: () => void): void {
    const outermost = !this.deferring;
    this.deferring = true;
    try {
      run();
    } finally {
      if (outermost) this.deferring = false;
    }
    if (outermost) this.flushDeferred();
  }

  /** A tick's publish point: publish now, or keep its header for the burst's final write. */
  publishTick(): void {
    if (this.deferring) this.deferWrite();
    else this.publish();
  }

  /** Publish now; a newer complete frame supersedes any write deferred by `advance()`. */
  publish(): void {
    const start = this.now();
    this.writePending = false;
    this.pendingPublishMs = 0;
    this.runPrelude();
    this.write(this.host.frameId(), this.world.clock.tickIndex, this.host.lastScriptMs(), this.host.lastPhysicsMs());
    this.notePublish(this.now() - start);
    if (this.host.recorder()?.recording) this.host.profilePublish(this._lastPublishMs);
  }

  /**
   * Write the frame deferred by the last publishing tick of a burst, with that
   * tick's header. Later ticks that no-op (pause, blocking stream) leave it as is.
   */
  flushDeferred(): void {
    if (!this.writePending) return;
    this.writePending = false;
    const spent = this.pendingPublishMs;
    this.pendingPublishMs = 0;
    if (this.host.stopped()) return;
    const start = this.now();
    // A later tick stopped before its publish point (blocking load, scene change)
    // leaves its removals to the next publish, as per-tick writes did; the write
    // below already omits actors that left the World. Its scripts may have moved
    // layout-managed overlay actors, so lay them out first, as every write does.
    // Otherwise the last publishing tick laid them out and nothing ran after it.
    if (this.host.canPublish()) this.retireRemovedActors();
    else this.host.applyOverlayLayouts();
    const header = this.pendingHeader;
    this.write(header.frameId, header.tickIndex, header.scriptMs, header.physicsMs);
    const publishMs = this.now() - start;
    this.notePublish(spent + publishMs);
    this.host.recorder()?.addPublishCost(header.tickIndex, publishMs);
  }

  private notePublish(milliseconds: number): void {
    this._lastPublishMs = milliseconds;
    this.publishSumMs += milliseconds;
    this.publishCount += 1;
  }

  /** Per-tick part of a deferred publish: overlay layout, removals and their commands happen in this tick. */
  private deferWrite(): void {
    const start = this.now();
    this.runPrelude();
    const header = this.pendingHeader;
    header.frameId = this.host.frameId();
    header.tickIndex = this.world.clock.tickIndex;
    header.scriptMs = this.host.lastScriptMs();
    header.physicsMs = this.host.lastPhysicsMs();
    this.writePending = true;
    const publishMs = this.now() - start;
    this.pendingPublishMs += publishMs;
    if (this.host.recorder()?.recording) this.host.profilePublish(publishMs);
  }

  /**
   * Publish work every publishing tick runs before its write. Overlay layout
   * moves SceneLayer actors that the next tick's focus navigation and scripts
   * read, so it stays per tick like removals.
   */
  private runPrelude(): void {
    this.host.applyOverlayLayouts();
    this.retireRemovedActors();
  }

  /**
   * Retire detached streams, then despawn and release slots of actors no
   * longer in the World, in slot allocation order (`RenderSlots.entries`).
   * An actor whose spawn is still queued (a Scene Layer created mid-tick
   * publishes before its actors commit) keeps its slot. After a pass every
   * slot's actor is live or queued. A live actor leaves only through a destroy
   * commit, which names its slot, and a slot is checked when allocated, so a
   * pass checks only those; a queued spawn can be cancelled without any
   * notification, so its slot is checked on every pass while it waits.
   */
  private retireRemovedActors(): void {
    this.host.retireDetachedStreams();
    const checks = this.slotChecks;
    if (this.fullSlotPass) {
      this.fullSlotPass = false;
      for (const [slotId] of this.slots.entries()) checks.add(slotId);
    }
    for (const slotId of this.queuedSlots) checks.add(slotId);
    for (const slotId of this.shadowedSlots) checks.add(slotId);
    if (checks.size === 0) return;
    this.queuedSlots.clear();
    const retiring = this.retiring;
    retiring.length = 0;
    for (const slotId of checks) {
      const owner = this.slots.owner(slotId);
      // The World's guid index answers whether this slot's own actor is still live.
      if (!owner || this.world.findActor(owner.guid) === owner) continue;
      if (this.world.isSpawnQueued(owner)) {
        this.queuedSlots.add(slotId);
        continue;
      }
      retiring.push(slotId);
    }
    checks.clear();
    if (retiring.length === 0) return;
    if (retiring.length > 1) retiring.sort(this.byAllocation);
    for (let index = 0; index < retiring.length; index++) {
      const slotId = retiring[index]!;
      const owner = this.slots.owner(slotId);
      if (!owner) continue;
      this.host.emit({ type: "despawn", slotId, actorGuid: owner.guid });
      this.slots.release(slotId);
    }
    this.host.removedActors();
  }

  /**
   * Every actor in `dirtyPoses` entered it with its whole subtree, and an actor that joins a subtree later (a
   * spawn or reparent under it) is marked with its own, so an actor already there needs no walk and a walk stops
   * at one: each coordinate write after the first costs one lookup. This also ends a walk around a parent cycle.
   */
  private markPoseDirtyWithDescendants(root: Actor): void {
    const dirty = this.dirtyPoses;
    if (dirty.has(root)) return;
    dirty.add(root);
    const direct = this.world.getChildren(root.guid);
    if (!direct || direct.size === 0) return;
    const stack = this.walkStack;
    stack.length = 0;
    for (const child of direct) {
      if (!child.destroyed && !dirty.has(child)) {
        dirty.add(child);
        stack.push(child);
      }
    }
    while (stack.length > 0) {
      const next = this.world.getChildren(stack.pop()!.guid);
      if (!next) continue;
      for (const child of next) {
        if (!child.destroyed && !dirty.has(child)) {
          dirty.add(child);
          stack.push(child);
        }
      }
    }
  }

  private write(frameId: number, tickIndex: number, scriptMs: number, physicsMs: number): void {
    const actors = this.world.getActors();
    const buf = this.snapshots.beginWrite();
    // After a structure or slot table change, dirty actors compose in World order as a pass over the World
    // does, so first-time shear warnings keep its order.
    const inWorldOrder = this.world.structuralRevision !== this.lastStructureRevision ||
      this.slots.revision !== this.lastSlotsRevision;
    this.lastStructureRevision = this.world.structuralRevision;
    this.lastSlotsRevision = this.slots.revision;

    let worldTransforms: ActorTransformMap;
    if (this.snapshots.maxActors !== this.lastCapacity || this.needsFullCompose) {
      this.lastCapacity = this.snapshots.maxActors;
      worldTransforms = this.composeAll(actors);
    } else {
      this.forgetDepartedPoses();
      worldTransforms = this.composeDirtyPoses(inWorldOrder) ?? this.composeAll(actors);
    }

    const cameraActor = this.host.cameraActor();
    const layerCentre = cameraActor ? null : this.host.layerCameraCentre();
    const cameraPosition = cameraActor ? worldTransforms.get(cameraActor.guid)?.position
      : layerCentre ? { x: layerCentre.x, y: layerCentre.y, z: 0 } : undefined;
    if (cameraPosition) {
      const next = { x: Math.floor(cameraPosition.x / 1024) * 1024, y: Math.floor(cameraPosition.y / 1024) * 1024, z: Math.floor(cameraPosition.z / 1024) * 1024 };
      if (next.x !== this.origin.x || next.y !== this.origin.y || next.z !== this.origin.z) { this.origin = next; this.originGeneration++; }
    }
    if (this.originGeneration !== this.lastOriginGeneration) {
      this.lastOriginGeneration = this.originGeneration;
      this.fullRewriteRemaining = 2;
      this.dirtySlotFrames.clear();
    }

    const rows = this.rowActors;
    let layoutChanged: boolean;
    if (this.fullRewriteRemaining > 0) {
      // Any pending candidate may have changed the layout since the frame the other buffer holds.
      layoutChanged = this.rowCandidates.size > 0;
      this.rowCandidates.clear();
      rows.length = 0;
      for (const actor of actors) {
        // Layout-only anchors must not create fallback visuals from pose snapshots.
        if (isSceneLayerAnchorActor(actor)) continue;
        const slotId = this.slots.recordedSlot(actor);
        if (slotId === undefined) continue;
        const pose = worldTransforms.get(actor.guid);
        if (!pose) continue;
        this.writeRow(buf, rows.length, actor, slotId, pose);
        rows.push(actor);
      }
      this.fullRewriteRemaining -= 1;
      if (this.dirtySlotFrames.size > 0) {
        for (const [actor, remaining] of this.dirtySlotFrames) {
          if (remaining <= 1) this.dirtySlotFrames.delete(actor);
          else this.dirtySlotFrames.set(actor, remaining - 1);
        }
      }
    } else {
      layoutChanged = this.collectRowChanges(worldTransforms);
      // The buffer being written holds the frame before last. When either frame moved rows, carry the last
      // frame's rows forward instead of rewriting every row, then move rows in place.
      if (layoutChanged || this.backStale) this.carryRowsForward(buf);
      if (layoutChanged) this.moveRows(buf);
      if (this.dirtySlotFrames.size > 0) {
        for (const [actor, remaining] of this.dirtySlotFrames) {
          const row = this.findRow(actor);
          if (row >= 0) {
            const slotId = this.slots.recordedSlot(actor);
            const pose = worldTransforms.get(actor.guid);
            if (slotId !== undefined && pose) this.writeRow(buf, row, actor, slotId, pose);
          }
          if (remaining <= 1) this.dirtySlotFrames.delete(actor);
          else this.dirtySlotFrames.set(actor, remaining - 1);
        }
      }
    }
    this.backStale = layoutChanged;
    writeSnapshotHeader(buf, {
      frameId,
      tickIndex,
      actorCount: rows.length,
      scriptMs,
      physicsMs,
      layoutGeneration: this._generation,
      origin: this.origin,
      originGeneration: this.originGeneration,
    });
    this.snapshots.publish();
    this._writes += 1;
  }

  /**
   * Compose every pose in World order and rewrite every row in both buffers: the first publish, a capacity
   * change and a parent cycle among dirty actors.
   */
  private composeAll(actors: readonly Actor[]): ActorTransformMap {
    const poses = this.poses.compose(this.findActor, actors, this.reportShearedActor);
    this.needsFullCompose = false;
    this.dirtyPoses.clear();
    this.departedPoses.clear();
    this.dirtySlotFrames.clear();
    this.fullRewriteRemaining = 2;
    return poses;
  }

  /** A departed actor's pose goes, unless a successor reusing its guid spawned (and is dirty). */
  private forgetDepartedPoses(): void {
    if (this.departedPoses.size === 0) return;
    for (const actor of this.departedPoses) {
      if (this.world.findActor(actor.guid) === undefined) this.poses.forget(actor.guid);
    }
    this.departedPoses.clear();
  }

  /**
   * Recompose the dirty actors (each entered with its subtree) and mark their rows for both buffers.
   * Null on a parent cycle: the caller recomposes the World.
   */
  private composeDirtyPoses(inWorldOrder: boolean): ActorTransformMap | null {
    const dirty = this.dirtyPoses;
    if (dirty.size === 0) return this.poses.current();
    for (const actor of dirty) {
      if (actor.destroyed) dirty.delete(actor);
      else this.dirtySlotFrames.set(actor, 2);
    }
    let selected: Iterable<Actor> = dirty;
    const order = this.composeOrder;
    if (inWorldOrder && dirty.size > 1) {
      for (const actor of dirty) order.push(actor);
      order.sort(bySpawnOrder);
      selected = order;
    }
    const poses = this.poses.composeDirty(this.findActor, selected, this.reportShearedActor);
    dirty.clear();
    order.length = 0;
    return poses;
  }

  /**
   * Sort `rowCandidates` into rows to remove, actors to insert and rows to rewrite in place
   * (`dirtySlotFrames`). True when rows are removed or inserted.
   */
  private collectRowChanges(poses: ActorTransformMap): boolean {
    if (this.rowCandidates.size === 0) return false;
    const removed = this.removedRows;
    const inserted = this.insertedRows;
    removed.length = 0;
    inserted.length = 0;
    for (const actor of this.rowCandidates) {
      const row = this.findRow(actor);
      const member = this.hasRow(actor, poses);
      if (row >= 0) {
        if (member) this.dirtySlotFrames.set(actor, 2);
        else removed.push(row);
      } else if (member) {
        inserted.push(actor);
      }
    }
    this.rowCandidates.clear();
    return removed.length > 0 || inserted.length > 0;
  }

  /** Whether a pass over the World writes a row for `actor`. */
  private hasRow(actor: Actor, poses: ActorTransformMap): boolean {
    return actor.world === this.world && !actor.destroyed && !isSceneLayerAnchorActor(actor) &&
      this.slots.recordedSlot(actor) !== undefined && poses.has(actor.guid);
  }

  /** Copy the last published frame's rows into the buffer being written. */
  private carryRowsForward(buf: Float32Array): void {
    const end = SNAPSHOT_HEADER_FLOATS + this.rowActors.length * SNAPSHOT_ACTOR_STRIDE;
    buf.set(this.snapshots.publishedBuffer().subarray(SNAPSHOT_HEADER_FLOATS, end), SNAPSHOT_HEADER_FLOATS);
  }

  /**
   * Remove `removedRows`, then insert `insertedRows` at their spawn-order positions, moving the rows
   * between them in one sweep each; `dirtySlotFrames` writes the inserted rows. A spawn usually appends.
   */
  private moveRows(buf: Float32Array): void {
    const rows = this.rowActors;
    const removed = this.removedRows;
    let count = rows.length;
    if (removed.length > 0) {
      if (removed.length > 1) removed.sort(ascending);
      let to = removed[0]!;
      for (let index = 0; index < removed.length; index++) {
        const from = removed[index]! + 1;
        const end = index + 1 < removed.length ? removed[index + 1]! : count;
        if (end > from) moveRowRange(buf, rows, from, end, to);
        to += end - from;
      }
      count -= removed.length;
      rows.length = count;
      removed.length = 0;
    }
    const inserted = this.insertedRows;
    if (inserted.length > 0) {
      if (inserted.length > 1) inserted.sort(bySpawnOrder);
      for (let index = 0; index < inserted.length; index++) rows.push(inserted[index]!);
      // Fill from the end: rows before `end` have not moved yet.
      let end = count;
      let to = rows.length;
      for (let index = inserted.length - 1; index >= 0; index--) {
        const actor = inserted[index]!;
        const at = this.lowerBound(actor.spawnOrder, end);
        to -= end - at;
        if (end > at) moveRowRange(buf, rows, at, end, to);
        to -= 1;
        rows[to] = actor;
        this.dirtySlotFrames.set(actor, 2);
        end = at;
      }
      inserted.length = 0;
    }
  }

  /** The row `actor` holds, or -1. */
  private findRow(actor: Actor): number {
    const row = this.lowerBound(actor.spawnOrder, this.rowActors.length);
    return this.rowActors[row] === actor ? row : -1;
  }

  /** The first row before `end` whose actor spawned at or after `spawnOrder`. */
  private lowerBound(spawnOrder: number, end: number): number {
    const rows = this.rowActors;
    let low = 0;
    let high = end;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle]!.spawnOrder < spawnOrder) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private writeRow(buf: Float32Array, row: number, actor: Actor, slotId: number, pose: Transform): void {
    const slot = this.slot;
    slot.slotId = slotId;
    slot.position = pose.position;
    slot.rotation = pose.rotation;
    slot.scale = pose.scale;
    slot.flags =
      (actor.getVariable("visible") === false ? 0 : SNAPSHOT_FLAG_VISIBLE) |
      (actor.sceneLayerId ? SNAPSHOT_FLAG_OVERLAY : 0);
    writeActorSlot(buf, row, slot, this.origin);
  }
}

const ascending = (a: number, b: number): number => a - b;
const bySpawnOrder = (a: Actor, b: Actor): number => a.spawnOrder - b.spawnOrder;

/** Move rows `[from, end)` to start at row `to`, in the buffer and in `rows`. */
function moveRowRange(buf: Float32Array, rows: Actor[], from: number, end: number, to: number): void {
  buf.copyWithin(
    SNAPSHOT_HEADER_FLOATS + to * SNAPSHOT_ACTOR_STRIDE,
    SNAPSHOT_HEADER_FLOATS + from * SNAPSHOT_ACTOR_STRIDE,
    SNAPSHOT_HEADER_FLOATS + end * SNAPSHOT_ACTOR_STRIDE,
  );
  rows.copyWithin(to, from, end);
}
