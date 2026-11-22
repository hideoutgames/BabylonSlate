import {
  ObjectCollector,
  canHoldReference,
  type CollectionResult,
  type EngineObject,
  type World,
} from "@haptic/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";

export { DEFAULT_GARBAGE_COLLECTION_INTERVAL_TICKS } from "@haptic/core";

/**
 * Marking work units (`ObjectCollector.workDone`) a collection cycle spends per
 * tick. Sized so a slice stays far below a frame's budget on a tablet: about
 * 0.1 ms on desktop. A world whose marking needs more takes several ticks.
 */
export const GARBAGE_COLLECTION_SLICE_WORK = 4096;

export type ObjectLifetimeStats = CollectionResult & {
  /** The tick the cycle finished at. */
  tickIndex: number;
  /** Ticks the cycle ran in, from its first slice to the one that finished it. */
  ticks: number;
  /** Wall time of the cycle's slices together, for the Stats line only; never used to decide anything. */
  ms: number;
  /** Collectable objects still alive after the pass. */
  collectable: number;
};

/** `gc stats` and the Stats line read the same numbers. */
export function formatObjectLifetimeStats(collectable: number, last: ObjectLifetimeStats | null): string {
  if (!last) return `${collectable} collectable objects; no collection pass yet`;
  return `${collectable} collectable objects; last pass at tick ${last.tickIndex}: ${last.marked} reached, ` +
    `${last.collected} collected, ${last.cleared} references cleared, ${last.ms.toFixed(2)} ms` +
    (last.ticks > 1 ? ` over ${last.ticks} ticks` : "");
}

interface ObjectLifetimeDeps {
  world(): World;
  /** Owned objects alive now, in a fixed order: they are roots. */
  roots(): Iterable<EngineObject | null | undefined>;
  intervalTicks(): number;
  now(): number;
}

/**
 * When the collector runs, always at the end of a tick when no script is
 * mid-call. A cycle starts at a tick index that is a multiple of
 * `intervalTicks`, when none is in progress and collectable objects exist or an
 * actor or layer was destroyed since the last cycle began. It marks at most
 * `GARBAGE_COLLECTION_SLICE_WORK` units per tick; once marking has nothing
 * left it finishes (rechecks and sweeps) at the next tick, or in the same tick
 * when the whole marking fit in its first slice. A Scene change, Collect
 * Garbage and the `gc` command finish a cycle in that tick: the one in progress,
 * or an atomic pass. A class registry change during a cycle restarts it as an
 * atomic pass, since the variables it skips as scalars may have changed.
 * Everything is counted in ticks and work units, never wall time.
 */
export class RuntimeObjectLifetime implements RuntimeSubsystem {
  readonly collector: ObjectCollector;
  private requested = false;
  private sceneChanged = false;
  private seenDestroyCount = 0;
  private last: ObjectLifetimeStats | null = null;
  /** The cycle in progress: its first tick, slice time so far and registry revision. */
  private cycleStartTick = 0;
  private cycleMs = 0;
  private cycleRegistryRevision = 0;
  /** Marking had nothing left at the end of an earlier tick of this cycle. */
  private markingDone = false;
  private readonly scalarCache = new Map<string, ReadonlySet<string>>();
  /** The class registry revision `scalarCache` was built at: hot reload re-declares variables. */
  private scalarRevision = -1;

  private readonly deps: ObjectLifetimeDeps;

  constructor(deps: ObjectLifetimeDeps) {
    this.deps = deps;
    this.collector = new ObjectCollector((classId) => this.scalarVariables(classId));
  }

  /** Runs a pass at the end of the current tick. */
  request(): void {
    this.requested = true;
  }

  /** The last pass, or null before the first. */
  get lastPass(): ObjectLifetimeStats | null {
    return this.last;
  }

  afterTick(tickIndex: number): void {
    const collector = this.collector;
    const world = this.deps.world();
    if (this.requested || this.sceneChanged) {
      const start = this.deps.now();
      this.requested = false;
      this.sceneChanged = false;
      if (!collector.collecting || world.classRegistry.revision !== this.cycleRegistryRevision) {
        this.startCycle(tickIndex, world);
        this.finishCycle(tickIndex, collector.collect(this.deps.roots()), start);
      } else {
        this.finishCycle(tickIndex, collector.finish(this.deps.roots()), start);
      }
      return;
    }
    if (collector.collecting) {
      const start = this.deps.now();
      if (world.classRegistry.revision !== this.cycleRegistryRevision) {
        this.startCycle(tickIndex, world);
        this.finishCycle(tickIndex, collector.collect(this.deps.roots()), start);
      } else if (this.markingDone) {
        this.finishCycle(tickIndex, collector.finish(this.deps.roots()), start);
      } else {
        this.markingDone = collector.step(GARBAGE_COLLECTION_SLICE_WORK);
        this.cycleMs += this.deps.now() - start;
      }
      return;
    }
    const interval = Math.max(1, Math.floor(this.deps.intervalTicks()));
    const work = collector.size > 0 || world.destroyCount !== this.seenDestroyCount;
    if (!work || tickIndex % interval !== 0) return;
    const start = this.deps.now();
    this.startCycle(tickIndex, world);
    collector.begin(this.deps.roots());
    // A world whose whole marking fits one slice finishes at once, as an atomic pass would.
    if (collector.step(GARBAGE_COLLECTION_SLICE_WORK)) {
      this.finishCycle(tickIndex, collector.finish(this.deps.roots()), start);
    } else {
      this.cycleMs += this.deps.now() - start;
    }
  }

  resetForSceneLoad(): void {
    this.sceneChanged = true;
    this.scalarCache.clear();
  }

  /** Stop: a cycle in progress ends without collecting, and lets go of the objects it held. */
  dispose(): void {
    this.collector.cancel();
  }

  private startCycle(tickIndex: number, world: World): void {
    this.seenDestroyCount = world.destroyCount;
    this.cycleStartTick = tickIndex;
    this.cycleMs = 0;
    this.cycleRegistryRevision = world.classRegistry.revision;
    this.markingDone = false;
  }

  private finishCycle(tickIndex: number, result: CollectionResult, start: number): void {
    this.markingDone = false;
    this.last = {
      ...result,
      tickIndex,
      ticks: tickIndex - this.cycleStartTick + 1,
      ms: this.cycleMs + this.deps.now() - start,
      collectable: this.collector.size,
    };
  }

  /** Variables a class declares with types that can never hold an object, which a pass skips. */
  private scalarVariables(classId: string): ReadonlySet<string> {
    const registry = this.deps.world().classRegistry;
    if (registry.revision !== this.scalarRevision) {
      this.scalarCache.clear();
      this.scalarRevision = registry.revision;
    }
    let names = this.scalarCache.get(classId);
    if (!names) {
      const declared = registry.inheritedVariables(classId);
      names = new Set(declared.filter((variable) => !canHoldReference(variable)).map((variable) => variable.name));
      this.scalarCache.set(classId, names);
    }
    return names;
  }
}
