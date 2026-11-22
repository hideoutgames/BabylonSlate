import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type ActorSlot,
  type CommandMessage,
} from "@haptic/bridge";
import { isSceneLayerAnchorActor } from "@haptic/core";
import type { Actor, World, WorldChangeObserver } from "@haptic/object-model";
import { actorLabel, WorldTransformComposer, type ActorTransformMap } from "./actor-world-transform";
import type { LogSeverity } from "./log-ring";
import type { RenderSlots } from "./render-slots";
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
 * final frame.
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
  private cachedCount = 0;
  private readonly rowByActor = new Map<Actor, { row: number; slotId: number }>();
  private readonly dirtyPoses = new Set<Actor>();
  private readonly dirtySlotFrames = new Map<Actor, number>();
  /** Reused by every descendant walk. */
  private readonly walkStack: Actor[] = [];
  private readonly unsubscribeWorld: () => void;
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
  /** The World structure and slot table the last removal pass checked, and whether it kept a spawn-queued actor's slot. */
  private readonly removalPass = { structure: -1, slots: -1, queued: false };
  private readonly world: World;
  private readonly slots: RenderSlots;
  private readonly host: SnapshotPublisherHost;
  private readonly now: () => number;

  private readonly worldObserver: WorldChangeObserver = {
    onActorTransformChanged: (actor) => {
      if (this.needsFullCompose) return;
      this.markPoseDirtyWithDescendants(actor);
    },
    onActorVariableChanged: (actor, name) => {
      if (name === "visible" || name === null) {
        this.dirtySlotFrames.set(actor, 2);
      }
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
  }

  dispose(): void {
    this.unsubscribeWorld();
    this.dirtyPoses.clear();
    this.dirtySlotFrames.clear();
    this.rowByActor.clear();
    this.walkStack.length = 0;
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
   * longer in the World. An actor whose spawn is still queued (a Scene Layer
   * created mid-tick publishes before its actors commit) keeps its slot.
   * After a pass every slot's actor is live or queued. A live actor leaves
   * only through a destroy commit or a Scene change, both of which advance
   * `structuralRevision`, but a queued spawn can be cancelled without one, so
   * the slots are checked again unless neither the World structure nor the
   * slot table changed and no slot was kept for a queued spawn.
   */
  private retireRemovedActors(): void {
    this.host.retireDetachedStreams();
    const pass = this.removalPass;
    const structure = this.world.structuralRevision;
    const slots = this.slots.revision;
    if (!pass.queued && pass.structure === structure && pass.slots === slots) return;
    pass.structure = structure;
    pass.slots = slots;
    pass.queued = false;
    let removedActors = false;
    for (const [slotId, owner] of this.slots.entries()) {
      // The World's guid index answers whether this slot's own actor is still live.
      if (this.world.findActor(owner.guid) === owner) continue;
      if (this.world.isSpawnQueued(owner)) {
        pass.queued = true;
        continue;
      }
      this.host.emit({ type: "despawn", slotId, actorGuid: owner.guid });
      this.slots.release(slotId);
      removedActors = true;
    }
    if (removedActors) this.host.removedActors();
  }

  /**
   * Every actor in `dirtyPoses` entered it with its whole subtree, and a structure change (a spawn or reparent
   * under it) recomposes everything, so an actor already there needs no walk and a walk stops at one: each
   * coordinate write after the first costs one lookup. This also ends a walk around a parent cycle.
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
    const findActor = this.findActor;
    const structureChanged = this.world.structuralRevision !== this.lastStructureRevision;
    const slotsChanged = this.slots.revision !== this.lastSlotsRevision;
    const capacityChanged = this.snapshots.maxActors !== this.lastCapacity;

    let worldTransforms: ActorTransformMap;
    if (structureChanged || slotsChanged || capacityChanged || this.needsFullCompose) {
      worldTransforms = this.poses.compose(findActor, actors, this.reportShearedActor);
      this.needsFullCompose = false;
      this.dirtyPoses.clear();
      this.dirtySlotFrames.clear();
      this.fullRewriteRemaining = 2;
      this.lastStructureRevision = this.world.structuralRevision;
      this.lastSlotsRevision = this.slots.revision;
      this.lastCapacity = this.snapshots.maxActors;
    } else if (this.dirtyPoses.size > 0) {
      for (const actor of this.dirtyPoses) this.dirtySlotFrames.set(actor, 2);
      const incremental = this.poses.composeDirty(findActor, this.dirtyPoses, this.reportShearedActor);
      this.dirtyPoses.clear();
      if (incremental === null) {
        worldTransforms = this.poses.compose(findActor, actors, this.reportShearedActor);
        this.fullRewriteRemaining = 2;
        this.dirtySlotFrames.clear();
      } else {
        worldTransforms = incremental;
      }
    } else {
      worldTransforms = this.poses.current();
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

    const slot = this.slot;
    let count: number;
    if (this.fullRewriteRemaining > 0) {
      this.rowByActor.clear();
      count = 0;
      for (const actor of actors) {
        // Layout-only anchors must not create fallback visuals from pose snapshots.
        if (isSceneLayerAnchorActor(actor)) continue;
        const slotId = this.slots.recordedSlot(actor);
        if (slotId === undefined) continue;
        const pose = worldTransforms.get(actor.guid);
        if (!pose) continue;
        slot.slotId = slotId;
        slot.position = pose.position;
        slot.rotation = pose.rotation;
        slot.scale = pose.scale;
        slot.flags =
          (actor.getVariable("visible") === false ? 0 : SNAPSHOT_FLAG_VISIBLE) |
          (actor.sceneLayerId ? SNAPSHOT_FLAG_OVERLAY : 0);
        writeActorSlot(buf, count, slot, this.origin);
        this.rowByActor.set(actor, { row: count, slotId });
        count += 1;
      }
      this.cachedCount = count;
      this.fullRewriteRemaining -= 1;
      if (this.dirtySlotFrames.size > 0) {
        for (const [actor, remaining] of this.dirtySlotFrames) {
          if (remaining <= 1) this.dirtySlotFrames.delete(actor);
          else this.dirtySlotFrames.set(actor, remaining - 1);
        }
      }
    } else {
      count = this.cachedCount;
      if (this.dirtySlotFrames.size > 0) {
        for (const [actor, remaining] of this.dirtySlotFrames) {
          const entry = this.rowByActor.get(actor);
          if (entry) {
            const pose = worldTransforms.get(actor.guid);
            if (pose) {
              slot.slotId = entry.slotId;
              slot.position = pose.position;
              slot.rotation = pose.rotation;
              slot.scale = pose.scale;
              slot.flags =
                (actor.getVariable("visible") === false ? 0 : SNAPSHOT_FLAG_VISIBLE) |
                (actor.sceneLayerId ? SNAPSHOT_FLAG_OVERLAY : 0);
              writeActorSlot(buf, entry.row, slot, this.origin);
            }
          }
          if (remaining <= 1) this.dirtySlotFrames.delete(actor);
          else this.dirtySlotFrames.set(actor, remaining - 1);
        }
      }
    }
    writeSnapshotHeader(buf, {
      frameId,
      tickIndex,
      actorCount: count,
      scriptMs,
      physicsMs,
      layoutGeneration: this._generation,
      origin: this.origin,
      originGeneration: this.originGeneration,
    });
    this.snapshots.publish();
    this._writes += 1;
  }
}
