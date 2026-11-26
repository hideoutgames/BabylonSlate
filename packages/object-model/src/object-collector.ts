import { EngineObject } from "./objects";

/** Hands one value that may hold object references to the collector. */
export type RootVisitor = (value: unknown) => void;
/** Reports values that keep objects alive: latent frames, blackboards, playing clips. */
export type RootSource = (visit: RootVisitor) => void;
/** Variable names of a class that can never hold an object, from its declared types. */
export type ScalarVariables = (classId: string) => ReadonlySet<string> | undefined;

export type CollectionResult = {
  /** Live objects reached from the roots. */
  marked: number;
  /** Collectable objects destroyed because nothing reached them. */
  collected: number;
  /** Stored references to destroyed objects set to None, or map entries removed. */
  cleared: number;
};

/** Containers nest at most this deep before the scan stops descending. */
const MAX_CONTAINER_DEPTH = 64;

/** Declared variable types that can hold an object reference, directly or inside a value. */
const REFERENCE_TYPES: ReadonlySet<string> = new Set(["object", "struct", "wildcard"]);

/** Whether a declared variable (type, and key type for a Map) can ever hold an object. */
export function canHoldReference(variable: { type: string; keyTypeId?: string; container?: string }): boolean {
  if (REFERENCE_TYPES.has(variable.type)) return true;
  return variable.container === "map" && REFERENCE_TYPES.has(variable.keyTypeId ?? "");
}

/** Cycle numbers handed out to every collector, so one cycle's marks never match another's. */
let lastCycle = 0;

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reference-based lifetime. Owned objects (actors, components, scenes, layers,
 * subsystems, the Game Instance) end only through their own routes and are
 * roots while alive. Collectable objects live while a root reaches them
 * through strong references: object variables, arrays, maps and structures,
 * and whatever root sources report. A cycle marks from the roots in a fixed
 * order, sets stored references to destroyed objects to None, and destroys
 * every collectable object it did not reach, without running script events.
 *
 * Class instances other than `EngineObject` (delegates, engine handles) are
 * not scanned, so they never keep an object alive.
 *
 * A cycle is either atomic (`collect`) or incremental: `begin` snapshots the
 * roots, `step` marks within a work budget between ticks while scripts keep
 * changing the graph, and `finish` completes it atomically. Every write to a
 * variable map advances its `variablesRevision`, but containers held in
 * variables (arrays, maps, structures) can change in place unseen, for example
 * from Execute JavaScript. So `finish` re-establishes reachability at that
 * moment before it sweeps: it marks the current roots and root sources,
 * rescans every owner scanned by a step whose revision moved, rescans the
 * containers of the others, and drains. Objects created during the cycle get
 * no special treatment: if they are reachable then, that pass reaches them.
 * The sweep stays in `finish`, because weak paths (delegates, the Objects tick
 * list) let a script store an unreached object again between ticks.
 *
 * Marks live on the objects (`EngineObject.collectorMark`), so an object
 * belongs to the graph of one collector.
 */
export class ObjectCollector {
  private readonly collectables: EngineObject[] = [];
  private readonly sources: RootSource[] = [];
  private readonly pending: EngineObject[] = [];
  private readonly releaseHandlers: Array<(object: EngineObject) => void> = [];
  private epoch = 0;
  private result: CollectionResult = { marked: 0, collected: 0, cleared: 0 };
  private readonly visitRoot: RootVisitor = (value) => {
    this.work++;
    this.visitValue(value, 0);
  };
  /** Work units spent since construction: one per root taken and per value inspected. */
  private work = 0;

  // Incremental cycle state; every list is reused by the next cycle.
  private cycleActive = false;
  /** Whether `begin` started the cycle, so steps may already have marked. */
  private incremental = false;
  /** Owned objects alive when the cycle began, marked by `step` in this order. */
  private readonly rootSnapshot: EngineObject[] = [];
  private rootCursor = 0;
  /** Whether `scanOwner` records what it scans, for `finish` to recheck: only inside `step`. */
  private recording = false;
  /** Owners `step` scanned, with their variable revision right after the scan. */
  private readonly scannedOwners: EngineObject[] = [];
  private readonly scannedRevisions: number[] = [];
  /** Containers those owners held in variables, with the index of the owner in `scannedOwners`. */
  private readonly scannedContainers: object[] = [];
  private readonly scannedContainerOwners: number[] = [];

  private readonly scalarVariables: ScalarVariables;

  constructor(scalarVariables: ScalarVariables = () => undefined) {
    this.scalarVariables = scalarVariables;
  }

  /** Collectable objects alive now, in creation order. */
  get size(): number {
    return this.collectables.length;
  }

  /** Whether an incremental cycle has begun and not finished. */
  get collecting(): boolean {
    return this.cycleActive;
  }

  /**
   * Work units spent since construction, never reset: one per root a step
   * takes and one per value inspected (a variable, an array slot, a map key or
   * value, a structure field) or owner rechecked. Callers compare two readings.
   */
  get workDone(): number {
    return this.work;
  }

  /** Puts `object` under reference-based lifetime. */
  register(object: EngineObject): void {
    if (object.destroyed) return;
    this.collectables.push(object);
  }

  /** Adds a root source; the returned function removes it. */
  addRootSource(source: RootSource): () => void {
    this.sources.push(source);
    return () => {
      const index = this.sources.indexOf(source);
      if (index >= 0) this.sources.splice(index, 1);
    };
  }

  /** Engine cleanup for a collected object: cancel its latent work, drop bindings. */
  onRelease(handler: (object: EngineObject) => void): void {
    this.releaseHandlers.push(handler);
  }

  /**
   * One atomic pass. `roots` are the owned objects alive now, in a fixed order;
   * root sources follow. Run it only when no script is mid-call. A cycle in
   * progress is abandoned: this pass marks everything again.
   */
  collect(roots: Iterable<EngineObject | null | undefined>): CollectionResult {
    this.startCycle();
    return this.finish(roots);
  }

  /**
   * Starts an incremental cycle from `roots` (copied, so the caller may reuse
   * the list). A cycle in progress is abandoned. Run it only when no script is
   * mid-call.
   */
  begin(roots: Iterable<EngineObject | null | undefined>): void {
    this.startCycle();
    this.incremental = true;
    for (const root of roots) if (root) this.rootSnapshot.push(root);
  }

  /**
   * Marks until `budget` work units are spent, stopping between owners, so a
   * step exceeds the budget by at most one owner's variables. Returns true when
   * marking has nothing left and only `finish` remains. Run it only when no
   * script is mid-call.
   */
  step(budget: number): boolean {
    if (!this.cycleActive) return true;
    const limit = this.work + budget;
    this.recording = true;
    try {
      while (this.work < limit) {
        const object = this.pending.pop();
        if (object) {
          this.scanOwner(object);
          continue;
        }
        if (this.rootCursor >= this.rootSnapshot.length) return true;
        this.work++;
        this.markObject(this.rootSnapshot[this.rootCursor++]!);
      }
      return this.pending.length === 0 && this.rootCursor >= this.rootSnapshot.length;
    } finally {
      this.recording = false;
    }
  }

  /**
   * Completes the cycle atomically from `roots`, the owned objects alive now,
   * and sweeps; without a cycle in progress this is an atomic pass. Run it
   * only when no script is mid-call.
   */
  finish(roots: Iterable<EngineObject | null | undefined>): CollectionResult {
    if (!this.cycleActive) this.startCycle();
    // Unprocessed snapshot roots that are still roots come back with `roots`.
    this.rootSnapshot.length = 0;
    this.rootCursor = 0;
    if (!this.incremental || this.hasUnmarkedCollectable()) {
      for (const root of roots) {
        this.work++;
        if (root) this.markObject(root);
      }
      for (const source of this.sources) source(this.visitRoot);
      this.recheckScanned();
      this.drain();
    }
    let kept = 0;
    for (const object of this.collectables) {
      if (!object.destroyed && object.collectorMark === this.epoch) {
        this.collectables[kept++] = object;
        continue;
      }
      if (object.destroyed) continue;
      object.destroyed = true;
      this.result.collected++;
      for (const handler of this.releaseHandlers) handler(object);
      object.releaseState();
    }
    this.collectables.length = kept;
    this.endCycle();
    return this.result;
  }

  /** Abandons a cycle in progress without collecting anything, and lets go of what it held. */
  cancel(): void {
    this.endCycle();
  }

  private startCycle(): void {
    this.endCycle();
    this.epoch = ++lastCycle;
    this.result = { marked: 0, collected: 0, cleared: 0 };
    this.cycleActive = true;
  }

  private endCycle(): void {
    this.cycleActive = false;
    this.incremental = false;
    this.recording = false;
    this.pending.length = 0;
    this.rootSnapshot.length = 0;
    this.rootCursor = 0;
    this.scannedOwners.length = 0;
    this.scannedRevisions.length = 0;
    this.scannedContainers.length = 0;
    this.scannedContainerOwners.length = 0;
  }

  /**
   * Whether a live collectable is still unmarked. When none is after the steps,
   * the sweep can collect nothing, so `finish` skips establishing reachability
   * again; references to destroyed objects that no step reached are cleared by
   * a later cycle.
   */
  private hasUnmarkedCollectable(): boolean {
    for (const object of this.collectables) {
      this.work++;
      if (!object.destroyed && object.collectorMark !== this.epoch) return true;
    }
    return false;
  }

  /**
   * Edges a step saw may have changed since: an owner whose revision moved is
   * scanned again in full; for the others only the containers can differ, so
   * they are scanned again. Owners destroyed since are no longer reached.
   */
  private recheckScanned(): void {
    const owners = this.scannedOwners;
    const revisions = this.scannedRevisions;
    for (let index = 0; index < owners.length; index++) {
      const owner = owners[index]!;
      this.work++;
      if (owner.destroyed) {
        revisions[index] = -1;
      } else if (owner.variablesRevision !== revisions[index]) {
        revisions[index] = -1;
        this.scanOwner(owner);
      }
    }
    const containers = this.scannedContainers;
    const containerOwners = this.scannedContainerOwners;
    for (let index = 0; index < containers.length; index++) {
      // -1: the owner is destroyed, or was rescanned above with the containers it holds now.
      if (revisions[containerOwners[index]!]! < 0) continue;
      this.visitValue(containers[index], 1);
    }
  }

  private markObject(object: EngineObject): void {
    if (object.destroyed || object.collectorMark === this.epoch) return;
    object.collectorMark = this.epoch;
    this.result.marked++;
    this.pending.push(object);
  }

  /** Scans marked objects' variables; a worklist, so long chains never deepen the stack. */
  private drain(): void {
    for (let object = this.pending.pop(); object; object = this.pending.pop()) this.scanOwner(object);
  }

  private scanOwner(object: EngineObject): void {
    const recording = this.recording;
    if (!object.hasNonPrimitiveVariables) {
      if (recording) {
        this.scannedOwners.push(object);
        this.scannedRevisions.push(object.variablesRevision);
      }
      return;
    }
    const scalars = this.scalarVariables(object.classId);
    const ownerIndex = this.scannedOwners.length;
    for (const [name, value] of object.variables) {
      this.work++;
      if (value === null || typeof value !== "object" || scalars?.has(name)) continue;
      if (value instanceof EngineObject) {
        if (value.destroyed) {
          object.variables.set(name, null);
          this.result.cleared++;
        } else {
          this.markObject(value);
        }
        continue;
      }
      if (recording && !Object.isFrozen(value)) {
        this.scannedContainers.push(value);
        this.scannedContainerOwners.push(ownerIndex);
      }
      this.visitValue(value, 1);
    }
    if (recording) {
      this.scannedOwners.push(object);
      // Read after the scan: clearing a destroyed reference above is a write.
      this.scannedRevisions.push(object.variablesRevision);
    }
  }

  /** Marks objects held by `value` and clears its references to destroyed objects. */
  private visitValue(value: unknown, depth: number): void {
    if (value === null || typeof value !== "object" || depth > MAX_CONTAINER_DEPTH) return;
    if (value instanceof EngineObject) {
      this.markObject(value);
      return;
    }
    if (Array.isArray(value)) {
      this.work += value.length;
      for (let index = 0; index < value.length; index++) {
        const entry: unknown = value[index];
        if (entry === null || typeof entry !== "object") continue;
        if (entry instanceof EngineObject && entry.destroyed) {
          value[index] = null;
          this.result.cleared++;
        } else {
          this.visitValue(entry, depth + 1);
        }
      }
      return;
    }
    if (value instanceof Map) {
      this.work += value.size * 2;
      for (const [key, entry] of value) {
        if (key instanceof EngineObject && key.destroyed) {
          value.delete(key);
          this.result.cleared++;
          continue;
        }
        this.visitValue(key, depth + 1);
        if (entry instanceof EngineObject && entry.destroyed) {
          value.set(key, null);
          this.result.cleared++;
        } else {
          this.visitValue(entry, depth + 1);
        }
      }
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const key in value) {
      this.work++;
      const entry = value[key];
      if (entry instanceof EngineObject && entry.destroyed) {
        value[key] = null;
        this.result.cleared++;
      } else {
        this.visitValue(entry, depth + 1);
      }
    }
  }
}
