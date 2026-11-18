import { describe, expect, it } from "vitest";
import { isPinWired, passesReference } from "./pin-connections";

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
});
