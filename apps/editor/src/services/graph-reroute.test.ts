import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import { compileGraph, ENGINE_SEED_STRUCT_ID } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import type { SerializedPin } from "@haptic/graph-ui";
import {
  hydrateSerializedGraphForEditor,
  materializeLogicGraph,
  scriptPaletteNodes,
  scriptPinCompatibility,
  scriptReroutePaletteNode,
  validateSerializedGraph,
} from "./graph-validation";

const registry = createDefaultNodeRegistry();
type Node = SerializedGraph["nodes"][number];
const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
/** A knot as an older save might hold it: the marker, and pins without `anyKind`. */
const knot = (id: string) =>
  node(id, "flow.reroute", {
    __reroute: true,
    __pins: [
      { id: "in", name: "In", kind: "data", direction: "in", type: { kind: "resolvingWildcard" } },
      { id: "out", name: "Out", kind: "data", direction: "out", type: { kind: "resolvingWildcard" } },
    ],
  });
const wire = (id: string, from: string, to: string) => {
  const [source, sourceHandle] = from.split(".") as [string, string];
  const [target, targetHandle] = to.split(".") as [string, string];
  return { id, source, sourceHandle, target, targetHandle };
};
const health = { variableName: "Health", typeId: "float", implicitSelf: true };

describe("Class graph Reroute knots", () => {
  const saved: SerializedGraph = {
    nodes: [
      node("begin", "flow.event.beginPlay"),
      knot("kx"),
      node("print", "debug.print"),
      node("number", "literal.makeFloat"),
      knot("k1"),
      knot("k2"),
      node("set", "variables.set", health),
      knot("ks"),
      node("get", "variables.get", health),
      knot("kg"),
      node("print2", "debug.print"),
    ],
    edges: [
      wire("x1", "begin.execOut", "kx.in"),
      wire("x2", "kx.out", "print.execIn"),
      wire("d1", "number.out", "k1.in"),
      wire("d2", "k1.out", "k2.in"),
      wire("d3", "k2.out", "print.value"),
      wire("x3", "print.execOut", "set.execIn"),
      // Wires from and into Get and Set Variable are type-checked as the graph loads.
      wire("x4", "set.execOut", "ks.in"),
      wire("x5", "ks.out", "print2.execIn"),
      wire("d4", "get.value", "kg.in"),
      wire("d5", "kg.out", "set.value"),
    ],
  };
  const knotIds = ["kx", "k1", "k2", "ks", "kg"];

  it("keeps every exec and data wire through knots when loaded, and again after a save and reload", () => {
    const hydrated = hydrateSerializedGraphForEditor(saved, registry);
    expect(hydrated.edges.map((edge) => edge.id)).toEqual(saved.edges.map((edge) => edge.id));
    for (const id of knotIds) {
      const data = hydrated.nodes.find((entry) => entry.id === id)!.data;
      expect(data.__reroute, id).toBe(true);
      expect((data.__pins as Array<{ anyKind?: boolean }>).map((pin) => pin.anyKind), id).toEqual([true, true]);
    }
    const reloaded = hydrateSerializedGraphForEditor(JSON.parse(JSON.stringify(hydrated)) as SerializedGraph, registry);
    expect(reloaded.edges.map((edge) => edge.id)).toEqual(saved.edges.map((edge) => edge.id));
    expect(reloaded.nodes.find((entry) => entry.id === "kx")!.data.__reroute).toBe(true);
  });

  it("never anchors a diagnostic on a knot, and reports an exec wire a knot ends on a data input at that input", () => {
    const options = {
      assetGuid: "hero",
      graphId: "EventGraph",
      classId: "Hero",
      members: [{ id: "health", classId: "Hero", kind: "variable" as const, name: "Health", typeId: "float" }],
    };
    const hydrated = hydrateSerializedGraphForEditor(saved, registry);
    expect(validateSerializedGraph(hydrated, options).filter((entry) => knotIds.includes(entry.nodeId ?? ""))).toEqual([]);

    const mixed = hydrateSerializedGraphForEditor({
      nodes: [node("begin", "flow.event.beginPlay"), knot("k"), node("print", "debug.print")],
      edges: [wire("x", "begin.execOut", "print.execIn"), wire("m1", "begin.execOut", "k.in"), wire("m2", "k.out", "print.value")],
    }, registry);
    const diagnostics = validateSerializedGraph(mixed, options);
    expect(diagnostics.filter((entry) => entry.code === "type.mismatch").map((entry) => [entry.nodeId, entry.pinId, entry.relatedNodeId]))
      .toEqual([["print", "value", "begin"]]);
    expect(diagnostics.some((entry) => entry.nodeId === "k")).toBe(false);
  });

  it("offers the Reroute row in every scripting host, marked as a knot", () => {
    const row = scriptReroutePaletteNode(registry);
    expect(row).toMatchObject({ id: "flow.reroute", title: "Reroute", defaultData: { __reroute: true } });
    expect(row?.pins?.map((pin) => [pin.id, pin.name, pin.direction, pin.anyKind])).toEqual([
      ["in", "In", "in", true],
      ["out", "Out", "out", true],
    ]);
    const hosts = [
      { parentClass: "Actor", classId: "Hero" },
      { parentClass: "Actor", classId: "Hero", activeFunctionId: "fn" },
      { parentClass: "Scene", classId: "Scene:level" },
      { animationGraphHost: "object" as const },
      { animationGraphHost: "rule" as const },
      { animationGraphHost: "pose" as const },
    ];
    for (const host of hosts) {
      const rows = scriptPaletteNodes(registry, host, { injectors: false });
      expect(rows.find((entry) => entry.id === "flow.reroute"), JSON.stringify(host)).toBe(row);
    }
  });

  it("types Get Assets By Class from a Class wired through a knot, and ignores a knot nothing feeds", () => {
    const classes = (graph: SerializedGraph) =>
      (hydrateSerializedGraphForEditor(graph, registry).nodes.find((entry) => entry.id === "assets")!.data.__pins as Array<{ id: string; type: unknown }>)
        .find((pin) => pin.id === "classes")?.type;
    const nodes = [
      node("kind", "variables.get", { variableName: "Kind", typeId: "class", typeClassId: "Actor", implicitSelf: true }),
      knot("k"),
      node("assets", "assetRegistry.getAssetsByClass", { "default:class": "Weapon" }),
    ];
    expect(classes({ nodes, edges: [wire("a", "kind.value", "k.in"), wire("b", "k.out", "assets.class")] }))
      .toEqual({ kind: "array", element: { kind: "classRef", classId: "Actor" } });
    expect(classes({ nodes, edges: [wire("b", "k.out", "assets.class")] }))
      .toEqual({ kind: "array", element: { kind: "classRef", classId: "Weapon" } });
  });

  it("types Cast from a Class wired through a knot", () => {
    const hydrated = hydrateSerializedGraphForEditor({
      nodes: [
        node("kind", "variables.get", { variableName: "Kind", typeId: "class", typeClassId: "Hero", implicitSelf: true }),
        knot("k"),
        node("cast", "casting.cast", { "default:class": "Weapon" }),
      ],
      edges: [wire("a", "kind.value", "k.in"), wire("b", "k.out", "cast.class")],
    }, registry, { parentOf: (id) => (id === "Hero" ? "Actor" : null) });
    const cast = hydrated.nodes.find((entry) => entry.id === "cast")!.data;
    expect(cast.title).toBe("Cast To Class");
    expect((cast.__pins as Array<{ id: string; type: unknown }>).find((pin) => pin.id === "result")?.type)
      .toEqual({ kind: "objectRef", classId: "Hero" });
  });

  it("takes an enum node's Enum from an enum value wired through a knot", () => {
    const enums = { "enum-team": { name: "Team", members: [{ name: "Red", value: 0 }, { name: "Blue", value: 1 }] } };
    const hydrated = hydrateSerializedGraphForEditor({
      nodes: [node("team", "enum.make", { enumGuid: "enum-team", value: "Blue" }), knot("k"), node("same", "enum.equals")],
      edges: [wire("a", "team.out", "k.in"), wire("b", "k.out", "same.a")],
    }, registry, { enums });
    expect(hydrated.nodes.find((entry) => entry.id === "same")!.data).toMatchObject({ enumGuid: "enum-team" });
  });

  describe("into a by-reference input", () => {
    const seed = { kind: "structRef", guid: ENGINE_SEED_STRUCT_ID } as const;
    const seedInput: SerializedPin = { id: "seed", name: "Seed", kind: "data", direction: "in", type: seed, reference: "required" };
    const out = (extra: Partial<SerializedPin>): SerializedPin => ({ id: "out", name: "Out", kind: "data", direction: "out", type: seed, ...extra });

    it("connects a knot carrying the input's type, which the rule cannot trace to its source, and still refuses a plain value", () => {
      const compatible = scriptPinCompatibility();
      expect(compatible(out({ anyKind: true }), seedInput)).toBe(true);
      expect(compatible(out({ reference: "writable" }), seedInput)).toBe(true);
      expect(compatible(out({}), seedInput)).toBe(false);
      // A knot of another type is still refused.
      expect(compatible(out({ anyKind: true, type: { kind: "int" } }), seedInput)).toBe(false);
    });

    it("reports a knot fed by a value on the real input, and accepts one fed by a writable variable", () => {
      const options = {
        assetGuid: "hero",
        graphId: "EventGraph",
        classId: "Hero",
        members: [{ id: "hits", classId: "Hero", kind: "variable" as const, name: "Hits", typeId: "int" }],
      };
      const referenceErrors = (source: Node, sourcePin: string) =>
        validateSerializedGraph(hydrateSerializedGraphForEditor({
          nodes: [node("begin", "flow.event.beginPlay"), source, knot("k"), node("value", "literal.makeInt"), node("set", "variables.setByRef")],
          edges: [
            wire("x", "begin.execOut", "set.execIn"),
            wire("t1", `${source.id}.${sourcePin}`, "k.in"),
            wire("t2", "k.out", "set.target"),
            wire("v", "value.out", "set.value"),
          ],
        }, registry), options)
          .filter((entry) => entry.code === "pin.invalid_reference")
          .map((entry) => [entry.nodeId, entry.pinId, entry.relatedNodeId]);
      expect(referenceErrors(node("number", "literal.makeInt"), "out")).toEqual([["set", "target", "number"]]);
      expect(referenceErrors(node("hits", "variables.get", { variableName: "Hits", typeId: "int", implicitSelf: true }), "value"))
        .toEqual([]);
    });
  });

  describe("in a function graph", () => {
    const pins = [
      { name: "exec", typeId: "exec", direction: "in" as const },
      { name: "then", typeId: "exec", direction: "out" as const },
      { name: "Amount", typeId: "float", direction: "in" as const },
      { name: "Result", typeId: "float", direction: "out" as const },
    ];
    const members = [{ id: "double", kind: "function" as const, name: "Double", pins }];
    const endpoints = () => [
      node("double-input", "flow.function.input", { title: "Input", __protected: true, pins }),
      node("double-output", "flow.function.output", { title: "Output", __protected: true, pins }),
      node("twice", "math.add"),
    ];
    const direct: SerializedGraph = {
      nodes: endpoints(),
      edges: [
        wire("x", "double-input.exec", "double-output.then"),
        wire("a", "double-input.Amount", "twice.a"),
        wire("b", "double-input.Amount", "twice.b"),
        wire("r", "twice.out", "double-output.Result"),
      ],
    };
    // The exec wire, Amount out of Input and Result into Output each run through knots.
    const rerouted: SerializedGraph = {
      nodes: [...endpoints(), knot("kx"), knot("ka"), knot("kr")],
      edges: [
        wire("x1", "double-input.exec", "kx.in"),
        wire("x2", "kx.out", "double-output.then"),
        wire("a1", "double-input.Amount", "ka.in"),
        wire("a2", "ka.out", "twice.a"),
        wire("b2", "ka.out", "twice.b"),
        wire("r1", "twice.out", "kr.in"),
        wire("r2", "kr.out", "double-output.Result"),
      ],
    };
    const hydrate = (slice: SerializedGraph) =>
      hydrateSerializedGraphForEditor({ ...slice, members }, registry, { functionId: "double", classId: "Hero" });

    it("keeps every wire through knots when loaded", () => {
      expect(hydrate(rerouted).edges.map((edge) => edge.id)).toEqual(rerouted.edges.map((edge) => edge.id));
    });

    it("validates cleanly and compiles exactly as the directly wired function", () => {
      const content = (slice: SerializedGraph): SerializedGraph => {
        const hydrated = hydrate(slice);
        return { nodes: [], edges: [], members, functionGraphs: { double: { nodes: hydrated.nodes, edges: hydrated.edges } } };
      };
      const options = { assetGuid: "hero", graphId: "EventGraph", classId: "Hero" };
      expect(validateSerializedGraph(content(rerouted), options)).toEqual(validateSerializedGraph(content(direct), options));
      expect(validateSerializedGraph(content(rerouted), options).filter((entry) => entry.severity === "error")).toEqual([]);
      const compiled = (slice: SerializedGraph) =>
        compileGraph(materializeLogicGraph(hydrate(slice), "double", "function"), { assetGuid: "hero", registry, exportName: "Double" }).source;
      expect(compiled(rerouted)).toBe(compiled(direct));
      expect(compiled(rerouted)).toContain("export function Double(ctx)");
    });
  });
});
