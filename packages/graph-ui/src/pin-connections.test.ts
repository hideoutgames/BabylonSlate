import { describe, expect, it } from "vitest";
import { buildReferencePins, buildWiredPins, isPinWired, passesReference } from "./pin-connections";

describe("wired-pin index", () => {
  it("bounds edge reads across repeated queries from many mounted pins", () => {
    let endpointReads = 0;
    const edges = Array.from({ length: 200 }, (_, i) => ({
      get source() {
        endpointReads++;
        return `source-${i}`;
      },
      get sourceHandle() {
        endpointReads++;
        return "value";
      },
      get target() {
        endpointReads++;
        return `target-${i}`;
      },
      get targetHandle() {
        endpointReads++;
        return "input";
      },
    }));

    for (let update = 0; update < 20; update++) {
      for (let i = 0; i < edges.length; i++) {
        expect(
          isPinWired(edges, `source-${i}`, { id: "value", direction: "out" }),
        ).toBe(true);
        expect(
          isPinWired(edges, `target-${i}`, { id: "input", direction: "in" }),
        ).toBe(true);
        expect(
          isPinWired(edges, `source-${i}`, { id: "unused", direction: "in" }),
        ).toBe(false);
      }
    }
    expect(endpointReads).toBeLessThanOrEqual(4 * edges.length);
  });

  it("keeps node, direction, and handle identities distinct, including unnamed handles", () => {
    const edges = [
      {
        source: "same",
        sourceHandle: "value",
        target: "same",
        targetHandle: "input",
      },
      { source: "unnamed", sourceHandle: null, target: "sink" },
      {
        source: "a\0b",
        sourceHandle: "c",
        target: "sink",
        targetHandle: "named",
      },
    ];
    expect(isPinWired(edges, "same", { id: "value", direction: "out" })).toBe(
      true,
    );
    expect(isPinWired(edges, "same", { id: "value", direction: "in" })).toBe(
      false,
    );
    expect(isPinWired(edges, "same", { id: "input", direction: "in" })).toBe(
      true,
    );
    expect(isPinWired(edges, "same", { id: "input", direction: "out" })).toBe(
      false,
    );
    expect(isPinWired(edges, "unnamed", { id: "", direction: "out" })).toBe(
      true,
    );
    expect(isPinWired(edges, "sink", { id: "", direction: "in" })).toBe(true);
    expect(
      isPinWired(edges, "unnamed", { id: "value", direction: "out" }),
    ).toBe(false);
    expect(isPinWired(edges, "a", { id: "b\0c", direction: "out" })).toBe(
      false,
    );
    expect(isPinWired(edges, "a\0b", { id: "c", direction: "out" })).toBe(true);
  });

  it("refreshes edge replacements and keeps other snapshots independent", () => {
    const first = {
      source: "source",
      sourceHandle: "value",
      target: "sink",
      targetHandle: "input",
    };
    const second = { ...first, source: "other" };
    const both = [first, second];
    const input = { id: "input", direction: "in" as const };
    expect(isPinWired(both, "sink", input)).toBe(true);
    expect(isPinWired([second], "sink", input)).toBe(true);
    expect(isPinWired([], "sink", input)).toBe(false);
    const reconnected = [{ ...first, targetHandle: "replacement" }];
    expect(isPinWired(reconnected, "sink", input)).toBe(false);
    expect(
      isPinWired(reconnected, "sink", { ...input, id: "replacement" }),
    ).toBe(true);
    expect(isPinWired(both, "sink", input)).toBe(true);
  });
});

describe("passesReference", () => {
  const variable = { id: "value", direction: "out" as const, reference: "writable" as const };
  const lookup = new Map<string, { data: Record<string, unknown> }>([
    ["get", { data: { __pins: [{ ...variable, name: "Value", kind: "data", type: { kind: "int" } }] } }],
    ["knot", { data: { __reroute: true, __pins: [] } }],
    ["seeded", { data: { __pins: [{ id: "seed", name: "Seed", kind: "data", direction: "in", type: { kind: "int" }, reference: "required" }] } }],
    ["print", { data: { __pins: [{ id: "text", name: "Text", kind: "data", direction: "in", type: { kind: "int" } }] } }],
  ]);
  const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ source, sourceHandle, target, targetHandle });

  it("passes the variable by reference into a reference input past a Reroute knot", () => {
    const edges = [wire("get", "value", "knot", "in"), wire("knot", "out", "seeded", "seed")];
    expect(passesReference(edges, lookup, "get", variable)).toBe(true);
  });

  it("does not when the knot leads only to a value input", () => {
    const edges = [wire("get", "value", "knot", "in"), wire("knot", "out", "print", "text")];
    expect(passesReference(edges, lookup, "get", variable)).toBe(false);
  });

  it("answers again for a new wire list or a changed node on the path, and reuses the answer while neither changes", () => {
    const edges = [wire("get", "value", "knot", "in"), wire("knot", "out", "seeded", "seed")];
    const reads = { count: 0 };
    const counted = (entries: Map<string, { data: Record<string, unknown> }>) =>
      new Proxy(entries, {
        get(target, key) {
          if (key === "get") return (id: string) => { reads.count += 1; return target.get(id); };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    expect(passesReference(edges, counted(lookup), "get", variable)).toBe(true);
    const walked = reads.count;
    // A frame that moved nodes keeps their data objects: only the nodes the walk read are checked.
    const moved = new Map(lookup);
    expect(passesReference(edges, counted(moved), "get", variable)).toBe(true);
    expect(reads.count - walked).toBeLessThanOrEqual(2);

    // The Seed input stops taking a reference: a new data object for a node on the path.
    const edited = new Map(lookup);
    edited.set("seeded", { data: { __pins: [{ id: "seed", name: "Seed", kind: "data", direction: "in", type: { kind: "int" } }] } });
    expect(passesReference(edges, edited, "get", variable)).toBe(false);
    // The knot becomes an ordinary node.
    const unknotted = new Map(lookup);
    unknotted.set("knot", { data: { __pins: [] } });
    expect(passesReference(edges, unknotted, "get", variable)).toBe(false);
    // A new wire list: the knot now leads to a value input.
    expect(passesReference([wire("get", "value", "knot", "in"), wire("knot", "out", "print", "text")], lookup, "get", variable)).toBe(false);
    expect(passesReference(edges, lookup, "get", variable)).toBe(true);
  });

  it("precomputes wired pins and reference-passing outputs in one pass for GraphNodeState", () => {
    const edges = [wire("get", "value", "knot", "in"), wire("knot", "out", "seeded", "seed")];
    const wired = buildWiredPins(edges);
    expect(wired.out.get("get")?.has("value")).toBe(true);
    expect(wired.in.get("seeded")?.has("seed")).toBe(true);
    expect(wired.in.get("print")).toBeUndefined();

    const nodes = [...lookup.entries()].map(([id, entry]) => ({ id, data: entry.data }));
    const refs = buildReferencePins(edges, nodes);
    expect(refs.get("get")?.has("value")).toBe(true);
    expect(refs.get("knot")).toBeUndefined();

    const valueOnlyEdges = [wire("get", "value", "knot", "in"), wire("knot", "out", "print", "text")];
    expect(buildReferencePins(valueOnlyEdges, nodes).size).toBe(0);
  });
});
