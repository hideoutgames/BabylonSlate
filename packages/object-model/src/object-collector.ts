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

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reference-based lifetime. Owned objects (actors, components, scenes, layers,
 * subsystems, the Game Instance) end only through their own routes and are
 * roots while alive. Collectable objects live while a root reaches them
 * through strong references: object variables, arrays, maps and structures,
 * and whatever root sources report. A pass marks from the roots in a fixed
 * order, sets stored references to destroyed objects to None, and destroys
 * every collectable object it did not reach, without running script events.
 *
 * Class instances other than `EngineObject` (delegates, engine handles) are
 * not scanned, so they never keep an object alive.
 */
export class ObjectCollector {
  private readonly collectables: EngineObject[] = [];
  private readonly sources: RootSource[] = [];
  private readonly marks = new WeakMap<EngineObject, number>();
  private readonly pending: EngineObject[] = [];
  private readonly releaseHandlers: Array<(object: EngineObject) => void> = [];
  private epoch = 0;
  private result: CollectionResult = { marked: 0, collected: 0, cleared: 0 };
  private readonly visitRoot: RootVisitor = (value) => this.visitValue(value, 0);

  private readonly scalarVariables: ScalarVariables;

  constructor(scalarVariables: ScalarVariables = () => undefined) {
    this.scalarVariables = scalarVariables;
  }

  /** Collectable objects alive now, in creation order. */
  get size(): number {
    return this.collectables.length;
  }

  /** Puts `object` under reference-based lifetime. */
  register(object: EngineObject): void {
    if (object.destroyed) return;
    this.collectables.push(object);
  }

  /** Whether `object` is collectable and still alive. */
  isCollectable(object: EngineObject): boolean {
    return !object.destroyed && this.collectables.includes(object);
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
   * One pass. `roots` are the owned objects alive now, in a fixed order; root
   * sources follow. Run it only when no script is mid-call.
   */
  collect(roots: Iterable<EngineObject | null | undefined>): CollectionResult {
    this.epoch++;
    this.result = { marked: 0, collected: 0, cleared: 0 };
    for (const root of roots) if (root) this.markObject(root);
    for (const source of this.sources) source(this.visitRoot);
    this.drain();
    let kept = 0;
    for (const object of this.collectables) {
      if (!object.destroyed && this.marks.get(object) === this.epoch) {
        this.collectables[kept++] = object;
        continue;
      }
      if (object.destroyed) continue;
      object.destroyed = true;
      this.result.collected++;
      for (const handler of this.releaseHandlers) handler(object);
    }
    this.collectables.length = kept;
    return this.result;
  }

  private markObject(object: EngineObject): void {
    if (object.destroyed || this.marks.get(object) === this.epoch) return;
    this.marks.set(object, this.epoch);
    this.result.marked++;
    this.pending.push(object);
  }

  /** Scans marked objects' variables; a worklist, so long chains never deepen the stack. */
  private drain(): void {
    while (this.pending.length > 0) {
      const object = this.pending.pop()!;
      const scalars = this.scalarVariables(object.classId);
      for (const [name, value] of object.variables) {
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
        this.visitValue(value, 1);
      }
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
      for (let index = 0; index < value.length; index++) {
        const entry: unknown = value[index];
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
    for (const key of Object.keys(value)) {
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
