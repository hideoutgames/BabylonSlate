import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type ActorSlot,
  type CommandMessage,
} from "@babylonslate/bridge";
import { isSceneLayerAnchorActor } from "@babylonslate/core";
import type { Actor, World } from "@babylonslate/object-model";
import { actorLabel, WorldTransformComposer } from "./actor-world-transform";
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
 * overlays and runs the removal pass, then composes world poses and writes
 * every live first-spawned actor's slot. `advance()` catch-up ticks keep their
 * per-tick layout and removals but write only the burst's final frame.
 */
export class SnapshotPublisher {
  private snapshots: SeqLockSnapshotPair;
  private _generation = 0;
  /** Publish-time world poses, rewritten in place each snapshot write. */
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
  /** Most recent publish: overlay layout and removal pass, composition and buffer write (stats `publishMs`). */
  private _lastPublishMs = 0;
  /** True while `advance()` runs catch-up ticks; their snapshot writes wait for the burst to end. */
  private deferring = false;
  /** Header of the last tick that reached its publish point while writes were deferred. */
  private readonly pendingHeader = { frameId: 0, tickIndex: 0, scriptMs: 0, physicsMs: 0 };
  private writePending = false;
  /** Removal-pass time already spent on the pending publish. */
  private pendingPublishMs = 0;
  private readonly world: World;
  private readonly slots: RenderSlots;
  private readonly host: SnapshotPublisherHost;
  private readonly now: () => number;

  constructor(maxActors: number, world: World, slots: RenderSlots, host: SnapshotPublisherHost, now: () => number) {
    this.snapshots = SeqLockSnapshotPair.create(maxActors);
    this.world = world;
    this.slots = slots;
    this.host = host;
    this.now = now;
    this.findActor = (guid) => world.findActor(guid);
  }

  get capacity(): number { return this.snapshots.maxActors; }
  get generation(): number { return this._generation; }
  get lastPublishMs(): number { return this._lastPublishMs; }

  /** Grow the buffers to hold `required` slots and announce the new layout, or report and throw. */
  ensureCapacity(required: number): void {
    if (required <= this.snapshots.maxActors) return;
    let capacity = Math.max(1, this.snapshots.maxActors);
    while (capacity < required) capacity *= 2;
    try {
      this.snapshots = SeqLockSnapshotPair.grow(this.snapshots, capacity);
      this._generation += 1;
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
    this._lastPublishMs = this.now() - start;
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
    this._lastPublishMs = spent + publishMs;
    this.host.recorder()?.addPublishCost(header.tickIndex, publishMs);
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

  /** Retire detached streams, then despawn and release slots of actors no longer in the World. */
  private retireRemovedActors(): void {
    this.host.retireDetachedStreams();
    let removedActors = false;
    for (const [actorGuid, slotId] of this.slots.guidEntries()) {
      // The World's guid index answers "any live actor has this guid".
      if (this.world.findActor(actorGuid)) continue;
      this.host.emit({ type: "despawn", slotId, actorGuid });
      this.slots.release(actorGuid, slotId);
      removedActors = true;
    }
    if (removedActors) this.host.removedActors();
  }

  private write(frameId: number, tickIndex: number, scriptMs: number, physicsMs: number): void {
    const actors = this.world.getActors();
    const buf = this.snapshots.beginWrite();
    const findActor = this.findActor;
    const worldTransforms = this.poses.compose(findActor, actors, this.reportShearedActor);
    const cameraActor = this.host.cameraActor();
    const cameraPosition = cameraActor ? worldTransforms.get(cameraActor.guid)?.position : undefined;
    if (cameraPosition) {
      const next = { x: Math.floor(cameraPosition.x / 1024) * 1024, y: Math.floor(cameraPosition.y / 1024) * 1024, z: Math.floor(cameraPosition.z / 1024) * 1024 };
      if (next.x !== this.origin.x || next.y !== this.origin.y || next.z !== this.origin.z) { this.origin = next; this.originGeneration++; }
    }
    const slot = this.slot;
    let count = 0;
    for (const actor of actors) {
      // Layout-only anchors must not create fallback visuals from pose snapshots.
      if (isSceneLayerAnchorActor(actor)) continue;
      // Only a guid's first-spawned live actor (the one parents, physics and
      // the crowd resolve) writes its own slot; later duplicates' slots get no
      // entry, although the guid maps to the latest-assigned one.
      if (findActor(actor.guid) !== actor) continue;
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
      count += 1;
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
  }
}
