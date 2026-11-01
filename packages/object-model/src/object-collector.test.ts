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
