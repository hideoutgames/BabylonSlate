import { describe, expect, it } from "vitest";
import { ObjectCollector, canHoldReference } from "./object-collector";
import { EngineObject } from "./objects";

let next = 0;
const object = (variables: Record<string, unknown> = {}, classId = "Thing") =>
  new EngineObject({ classId, guid: `o${++next}`, variables });

function collector(scalars: Record<string, string[]> = {}) {
  return new ObjectCollector((classId) => (scalars[classId] ? new Set(scalars[classId]) : undefined));
}

describe("ObjectCollector", () => {
  it("keeps collectable objects a root reaches through variables, arrays, maps and structures", () => {
    const gc = collector();
    const direct = object();
    const inArray = object();
    const mapKey = object();
    const mapValue = object();
    const inStruct = object();
    const chained = object();
    const orphan = object();
    for (const target of [direct, inArray, mapKey, mapValue, inStruct, chained, orphan]) gc.register(target);
    direct.setVariable("Next", chained);
    const root = object({
      Direct: direct,
      List: [null, inArray],
      Lookup: new Map<unknown, unknown>([[mapKey, 1], ["k", mapValue]]),
      Hit: { Actor: inStruct, Distance: 3 },
    });

    const result = gc.collect([root]);

    expect([direct, inArray, mapKey, mapValue, inStruct, chained].map((entry) => entry.destroyed)).toEqual([false, false, false, false, false, false]);
    expect(orphan.destroyed).toBe(true);
    expect(result.collected).toBe(1);
    expect(gc.size).toBe(6);
  });

  it("collects an object once nothing references it any more, and never revives it", () => {
    const gc = collector();
    const held = object();
    gc.register(held);
    const root = object({ Held: held });
    gc.collect([root]);
    expect(held.destroyed).toBe(false);

    root.setVariable("Held", null);
    expect(gc.collect([root]).collected).toBe(1);
    expect(held.destroyed).toBe(true);

    root.setVariable("Held", held);
    expect(gc.collect([root]).collected).toBe(0);
    expect(gc.size).toBe(0);
  });

  it("collects a cycle that no root reaches", () => {
    const gc = collector();
    const a = object();
    const b = object({ Other: a });
    a.setVariable("Other", b);
    gc.register(a);
    gc.register(b);
    expect(gc.collect([object()]).collected).toBe(2);
  });

  it("sets stored references to destroyed objects to None and drops map entries keyed by them", () => {
    const gc = collector();
    const gone = object();
    gone.destroyed = true;
    const kept = object();
    const root = object({
      Direct: gone,
      List: [gone, kept],
      ByKey: new Map([[gone, "x"], [kept, "y"]]),
      ByValue: new Map([["a", gone]]),
      Hit: { Actor: gone },
    });

    const result = gc.collect([root]);

    expect(root.getVariable("Direct")).toBeNull();
    expect(root.getVariable("List")).toEqual([null, kept]);
    expect([...(root.getVariable("ByKey") as Map<unknown, unknown>).keys()]).toEqual([kept]);
    expect((root.getVariable("ByValue") as Map<unknown, unknown>).get("a")).toBeNull();
    expect(root.getVariable("Hit")).toEqual({ Actor: null });
    expect(result.cleared).toBe(5);
  });

  it("keeps objects reported by root sources until the source is removed", () => {
    const gc = collector();
    const pending = object();
    gc.register(pending);
    const remove = gc.addRootSource((visit) => visit([pending]));
    expect(gc.collect([]).collected).toBe(0);
    remove();
    expect(gc.collect([]).collected).toBe(1);
  });

  it("never keeps an object alive through a class instance such as a delegate", () => {
    class Delegate {
      constructor(readonly target: EngineObject) {}
    }
    const gc = collector();
    const listener = object();
    gc.register(listener);
    expect(gc.collect([object({ OnHit: new Delegate(listener) })]).collected).toBe(1);
  });

  it("skips variables the class declares as never holding an object", () => {
    const gc = collector({ Scorer: ["Score"] });
    const hidden = object();
    gc.register(hidden);
    // A scalar-declared variable is not scanned, so what it holds is not a reference.
    expect(gc.collect([object({ Score: { stray: hidden } }, "Scorer")]).collected).toBe(1);
  });

  it("runs release handlers for each collected object, in creation order", () => {
    const gc = collector();
    const first = object();
    const second = object();
    gc.register(first);
    gc.register(second);
    const released: EngineObject[] = [];
    gc.onRelease((entry) => released.push(entry));
    gc.collect([]);
    expect(released).toEqual([first, second]);
  });
});

describe("ObjectCollector cost", () => {
  it("marks each reachable object once, however many references reach it", () => {
    const gc = collector({ Node: ["Index"] });
    const nodes = Array.from({ length: 2000 }, (_, index) => object({ Index: index }, "Node"));
    for (const node of nodes) gc.register(node);
    // A chain, every node also listed in one array, and a cycle back to the start.
    nodes.forEach((node, index) => node.setVariable("Next", nodes[(index + 1) % nodes.length]));
    const root = object({ All: [...nodes], First: nodes[0], Twice: [nodes[0], nodes[0]] });

    const result = gc.collect([root, root]);

    expect(result).toEqual({ marked: nodes.length + 1, collected: 0, cleared: 0 });
    expect(gc.collect([root]).marked).toBe(nodes.length + 1);
  });
});

describe("ObjectCollector incremental cycles", () => {
  it("keeps an object moved in place from a container not yet scanned into one already scanned", () => {
    const gc = collector();
    const moved = object();
    gc.register(moved);
    const scanned = object({ List: [] as unknown[] });
    const later = object({ Hold: [moved] });

    gc.begin([scanned, later]);
    // Take `scanned` (1) and scan its one variable holding an empty array (1): `later` is not reached yet.
    expect(gc.step(2)).toBe(false);
    // A script moves the object between arrays in place: no variable write records it.
    (later.getVariable("Hold") as unknown[]).splice(0, 1);
    (scanned.getVariable("List") as unknown[]).push(moved);
    while (!gc.step(2)) { /* mark */ }

    expect(gc.finish([scanned, later]).collected).toBe(0);
    expect(moved.destroyed).toBe(false);
  });

  it("keeps an object written into a variable already scanned, and one held by a root that appeared", () => {
    const gc = collector();
    const moved = object();
    const created = object();
    gc.register(moved);
    const scanned = object({ Score: 1 });
    const later = object({ Hold: moved });

    gc.begin([scanned, later]);
    expect(gc.step(2)).toBe(false);
    later.setVariable("Hold", null);
    scanned.setVariable("Slot", moved);
    // Created during the cycle and held only by an owned object spawned during it.
    gc.register(created);
    const spawned = object({ Held: created });
    while (!gc.step(2)) { /* mark */ }

    expect(gc.finish([scanned, later, spawned]).collected).toBe(0);
    expect([moved.destroyed, created.destroyed]).toEqual([false, false]);
  });

  it("never collects what an atomic pass at the same moment keeps, under random script changes between steps", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const run = randomGraph(seed);
      for (let cycle = 0; cycle < 12; cycle++) {
        run.gc.begin(run.roots);
        for (let done = false; !done;) {
          run.mutate(run.random.int(4));
          done = run.gc.step(1 + run.random.int(40));
        }
        run.mutate(run.random.int(4));
        const kept = reachableFrom(run.roots, run.sourceValues);
        run.gc.finish(run.roots);
        const lost = run.collectables.filter((entry) => kept.has(entry) && entry.destroyed);
        expect(lost.map((entry) => entry.guid), `seed ${seed}, cycle ${cycle}`).toEqual([]);
      }
      // Bound: once the graph stops changing, the next cycle collects every unreachable object.
      const kept = reachableFrom(run.roots, run.sourceValues);
      run.gc.begin(run.roots);
      while (!run.gc.step(1 + run.random.int(40))) { /* mark */ }
      run.gc.finish(run.roots);
      const alive = run.collectables.filter((entry) => !entry.destroyed);
      expect(alive.map((entry) => entry.guid), `seed ${seed}`).toEqual(run.collectables.filter((entry) => kept.has(entry)).map((entry) => entry.guid));
    }
  });

  it("collects as an atomic pass does when nothing changes during the cycle", () => {
    const gc = collector();
    const held = object();
    const orphan = object();
    gc.register(held);
    gc.register(orphan);
    const roots = Array.from({ length: 40 }, (_, index) => object({ Index: index, Tags: ["a", "b"], Hit: { Actor: index === 7 ? held : null } }));

    gc.begin(roots);
    let steps = 0;
    while (!gc.step(16)) steps++;

    expect(steps).toBeGreaterThan(3);
    expect(gc.finish(roots)).toEqual({ marked: roots.length + 1, collected: 1, cleared: 0 });
    expect([held.destroyed, orphan.destroyed]).toEqual([false, true]);
  });

  it("skips scanning primitive-only owners in O(1) while still catching references written during an incremental cycle", () => {
    const gc = collector();
    const held = object();
    gc.register(held);
    const primOnly = object({ Score: 42, Label: "ok", Alive: true });
    const holder = object({ Held: held });
    expect(primOnly.hasNonPrimitiveVariables).toBe(false);

    gc.begin([primOnly, holder]);
    const workBefore = gc.workDone;
    // Taking primOnly (1) + scanning it (0 map entries walked) does not touch holder yet.
    expect(gc.step(1)).toBe(false);
    expect(gc.workDone - workBefore).toBe(1);

    // Move `held` onto `primOnly` mid-cycle and clear `holder`.
    holder.setVariable("Held", null);
    primOnly.setVariable("Ref", held);
    expect(primOnly.hasNonPrimitiveVariables).toBe(true);
    while (!gc.step(2)) { /* mark */ }

    expect(gc.finish([primOnly, holder]).collected).toBe(0);
    expect(held.destroyed).toBe(false);
  });
});

/** Deterministic random numbers for the differential test. */
function randomSource(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}

/** Objects an atomic pass keeps, found independently: everything reached through variables, arrays, maps and records. */
function reachableFrom(roots: readonly EngineObject[], sourceValues: readonly unknown[]): Set<EngineObject> {
  const reached = new Set<EngineObject>();
  const stack: unknown[] = [...roots, ...sourceValues];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") continue;
    if (value instanceof EngineObject) {
      if (value.destroyed || reached.has(value)) continue;
      reached.add(value);
      stack.push(...value.variables.values());
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (value instanceof Map) {
      for (const [key, entry] of value) stack.push(key, entry);
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      stack.push(...Object.values(value));
    }
  }
  return reached;
}

/**
 * Owned roots, collectable objects and a root source, and the changes scripts
 * make between collector steps: variable writes and deletes, in-place array,
 * structure and map edits, aliasing a container into a second variable, moving
 * a reference between owners, Create Object, destroying an owned object and
 * spawning one. Writes reach unreachable objects too, as delegates and the
 * Objects tick list let scripts do. In-place edits store leaves only, so
 * containers never contain themselves.
 */
function randomGraph(seed: number) {
  const random = randomSource(seed);
  const gc = collector();
  const roots: EngineObject[] = [];
  const collectables: EngineObject[] = [];
  let sourceValues: unknown[] = [];
  gc.addRootSource((visit) => sourceValues.forEach(visit));
  const names = ["A", "B", "C"];
  const pick = <T>(list: readonly T[]): T | undefined => list[random.int(list.length)];
  const live = () => [...roots, ...collectables].filter((entry) => !entry.destroyed);
  const leaf = (): unknown => {
    switch (random.int(6)) {
      case 0: return null;
      case 1: return random.int(10);
      case 2: return [pick(live()) ?? null, 1];
      case 3: return { Actor: pick(live()) ?? null, Distance: 2 };
      case 4: return new Map<unknown, unknown>([[pick(live()) ?? "k", pick(live()) ?? null]]);
      default: return pick(live()) ?? null;
    }
  };
  const containersOf = (owner: EngineObject): object[] => {
    const found: object[] = [];
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || value instanceof EngineObject) return;
      found.push(value);
      if (Array.isArray(value)) value.forEach(walk);
      else if (value instanceof Map) value.forEach((entry, key) => { walk(key); walk(entry); });
      else Object.values(value).forEach(walk);
    };
    owner.variables.forEach(walk);
    return found;
  };
  const create = () => {
    const created = object({ [pick(names)!]: leaf() });
    gc.register(created);
    collectables.push(created);
    return created;
  };
  for (let index = 0; index < 4; index++) roots.push(object({ A: leaf() }));
  for (let index = 0; index < 12; index++) {
    const created = create();
    pick(live())!.setVariable(pick(names)!, random.int(2) ? created : [created]);
  }

  const mutate = (count: number) => {
    for (let change = 0; change < count; change++) {
      const owner = pick(live())!;
      const container = pick(containersOf(owner));
      switch (random.int(12)) {
        case 0: owner.setVariable(pick(names)!, leaf()); break;
        case 1: owner.variables.delete(pick(names)!); break;
        case 2: if (Array.isArray(container)) container.push(leaf()); break;
        case 3: if (Array.isArray(container) && container.length > 0) container.splice(random.int(container.length), 1); break;
        case 4: if (Array.isArray(container) && container.length > 0) container[random.int(container.length)] = leaf(); break;
        case 5:
          if (container instanceof Map) container.set(pick(live()) ?? "k", leaf());
          else if (container && !Array.isArray(container)) (container as Record<string, unknown>)[pick(["Actor", "Other"])!] = leaf();
          break;
        case 6: if (container instanceof Map) container.delete(pick([...container.keys()])); break;
        case 7: {
          // Alias: a script reads a container from one object and stores it on another.
          const alias = pick(containersOf(pick(live())!));
          if (alias) owner.setVariable(pick(names)!, alias);
          break;
        }
        case 8: {
          // Move a reference from one owner to another (a reparent).
          const name = pick(names)!;
          const moved = owner.getVariable(name);
          owner.setVariable(name, null);
          pick(live())!.setVariable(pick(names)!, moved);
          break;
        }
        case 9: {
          const created = create();
          if (random.int(2)) owner.setVariable(pick(names)!, created);
          break;
        }
        case 10:
          if (roots.length > 1 && random.int(2)) {
            const [gone] = roots.splice(random.int(roots.length), 1);
            gone!.destroyed = true;
            gone!.releaseState();
          } else {
            roots.push(object({ A: leaf(), B: leaf() }));
          }
          break;
        default: sourceValues = random.int(2) ? [leaf()] : []; break;
      }
    }
  };
  return { gc, roots, collectables, random, mutate, get sourceValues() { return sourceValues; } };
}

describe("canHoldReference", () => {
  it.each([
    [{ type: "object" }, true],
    [{ type: "struct" }, true],
    [{ type: "wildcard" }, true],
    [{ type: "float" }, false],
    [{ type: "vec3", container: "array" }, false],
    [{ type: "int", container: "map", keyTypeId: "object" }, true],
    [{ type: "string", container: "map", keyTypeId: "string" }, false],
  ])("%j → %s", (variable, expected) => {
    expect(canHoldReference(variable)).toBe(expected);
  });
});
