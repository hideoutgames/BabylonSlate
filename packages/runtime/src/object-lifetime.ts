import {
  ObjectCollector,
  canHoldReference,
  type CollectionResult,
  type EngineObject,
  type World,
} from "@haptic/object-model";
import type { RuntimeSubsystem } from "./runtime-subsystems";

/** About one second at the default 60 Hz simulation step. */
export const DEFAULT_GARBAGE_COLLECTION_INTERVAL_TICKS = 60;

export type ObjectLifetimeStats = CollectionResult & {
  /** The tick the pass ran at. */
  tickIndex: number;
  /** Wall time the pass took, for the Stats line only; never used to decide anything. */
  ms: number;
  /** Collectable objects still alive after the pass. */
  collectable: number;
};

interface ObjectLifetimeDeps {
  world(): World;
  /** Owned objects alive now, in a fixed order: they are roots. */
  roots(): Iterable<EngineObject | null | undefined>;
  intervalTicks(): number;
  now(): number;
}

/**
 * When the collector runs. A pass runs at the end of a tick, when no script is
 * mid-call: every `intervalTicks` ticks while collectable objects exist or an
 * actor or layer was destroyed since the last pass, after a Scene change, and
 * when Collect Garbage or the `gc` command asked for one.
 */
export class RuntimeObjectLifetime implements RuntimeSubsystem {
  readonly collector: ObjectCollector;
  private requested = false;
  private sceneChanged = false;
  private seenDestroyCount = 0;
  private last: ObjectLifetimeStats | null = null;
  private readonly scalarCache = new Map<string, ReadonlySet<string>>();

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
    const world = this.deps.world();
    const interval = Math.max(1, Math.floor(this.deps.intervalTicks()));
    const work = this.collector.size > 0 || world.destroyCount !== this.seenDestroyCount;
    if (!this.requested && !this.sceneChanged && !(work && tickIndex % interval === 0)) return;
    const start = this.deps.now();
    this.requested = false;
    this.sceneChanged = false;
    this.seenDestroyCount = world.destroyCount;
    const result = this.collector.collect(this.deps.roots());
    this.last = { ...result, tickIndex, ms: this.deps.now() - start, collectable: this.collector.size };
  }

  resetForSceneLoad(): void {
    this.sceneChanged = true;
    this.scalarCache.clear();
  }

  /** Variables a class declares with types that can never hold an object, which a pass skips. */
  private scalarVariables(classId: string): ReadonlySet<string> {
    let names = this.scalarCache.get(classId);
    if (!names) {
      const declared = this.deps.world().classRegistry.inheritedVariables(classId);
      names = new Set(declared.filter((variable) => !canHoldReference(variable)).map((variable) => variable.name));
      this.scalarCache.set(classId, names);
    }
    return names;
  }
}
