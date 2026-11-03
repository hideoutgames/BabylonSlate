import { describe, expect, it } from "vitest";
import {
  PARTICLE_PARAMETER_NAME_MAX,
  createDefaultParticleGraphDocument,
  type ParticleGraphDocument,
  type ParticleGraphNode,
} from "./document";
import {
  convertParticleConstantToParameter,
  convertParticleParameterToConstant,
  particleConstantValueType,
  particleParameterSnapshot,
  reconcileParticleParameters,
  uniqueParticleParameterName,
  withParticleParameter,
} from "./parameter-nodes";
import { validateParticleGraphDocument } from "./validate";

function ids(prefix = "p"): () => string {
  let next = 0;
  return () => `${prefix}-${(next += 1)}`;
}

function nodeOf(doc: ParticleGraphDocument, id: string): ParticleGraphNode {
  return doc.nodes.find((node) => node.id === id)!;
}

/** The default graph with a Float Constant feeding Create Particle's Lifetime. */
function withConstant(): ParticleGraphDocument {
  const doc = createDefaultParticleGraphDocument("Embers");
  doc.nodes.push({ id: "push", type: "const.float", position: { x: 40, y: 80 }, properties: { value: [2.5] } });
  doc.edges.push({ id: "push-lifetime", sourceNodeId: "push", sourcePinId: "out", targetNodeId: "create", targetPinId: "lifetime" });
  return doc;
}

function parameterNode(id: string, parameterId: string, valueType = "float"): ParticleGraphNode {
  return { id, type: "input.parameter", position: { x: 0, y: 0 }, properties: { parameterId, valueType } };
}

const heat = { id: "heat", name: "Heat", type: "float" as const, defaultValue: [1] };

describe("particle parameter nodes", () => {
  it("names the Constant types", () => {
    expect(particleConstantValueType("const.color")).toBe("color");
    expect(particleConstantValueType("input.parameter")).toBeNull();
  });

  it("makes a taken name unique with the first free _N suffix", () => {
    const named = (...names: string[]) =>
      names.map((name, index) => ({ id: `n-${index}`, name, type: "float" as const, defaultValue: [0] }));
    expect(uniqueParticleParameterName(named("Heat"))).toBe("Parameter");
    expect(uniqueParticleParameterName(named("Parameter", "Parameter_1"))).toBe("Parameter_2");
    // A copy of `Heat_1` counts on from its stem.
    expect(uniqueParticleParameterName(named("Heat", "Heat_1"), "Heat_1")).toBe("Heat_2");
    // A rename keeps its own name.
    expect(uniqueParticleParameterName(named("Heat"), "Heat", "n-0")).toBe("Heat");
    const long = "L".repeat(PARTICLE_PARAMETER_NAME_MAX);
    const unique = uniqueParticleParameterName(named(long), long);
    expect(unique).toBe(`${"L".repeat(PARTICLE_PARAMETER_NAME_MAX - 2)}_1`);
  });

  it("converts a Constant to a Parameter holding its value, keeping the node and its wires", () => {
    const doc = withConstant();
    const next = convertParticleConstantToParameter(doc, "push", ids())!;
    expect(next.parameters).toEqual([{ id: "p-1", name: "Parameter", type: "float", defaultValue: [2.5] }]);
    expect(nodeOf(next, "push")).toEqual({
      id: "push",
      type: "input.parameter",
      position: { x: 40, y: 80 },
      properties: { parameterId: "p-1", valueType: "float" },
    });
    expect(next.edges).toEqual(doc.edges);
    expect(validateParticleGraphDocument(next).filter((row) => row.severity === "error")).toEqual([]);
    // Another conversion gets a free name.
    expect(convertParticleConstantToParameter({ ...withConstant(), parameters: next.parameters }, "push", ids("q"))!
      .parameters.map((parameter) => parameter.name)).toEqual(["Parameter", "Parameter_1"]);
    expect(convertParticleConstantToParameter(doc, "create", ids())).toBeNull();
  });

  it("converts a Parameter back to a Constant of its default and drops the parameter", () => {
    const doc = convertParticleConstantToParameter(withConstant(), "push", ids())!;
    const back = convertParticleParameterToConstant(doc, "push")!;
    expect(nodeOf(back, "push")).toMatchObject({ type: "const.float", properties: { value: [2.5] } });
    expect(back.parameters).toEqual([]);
    expect(back.edges).toEqual(doc.edges);
    expect(convertParticleParameterToConstant(doc, "create")).toBeNull();
  });

  it("converts a Parameter whose parameter is gone to its type's starting Constant", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.nodes.push(parameterNode("lost", "gone", "color"));
    expect(nodeOf(convertParticleParameterToConstant(doc, "lost")!, "lost")).toMatchObject({
      type: "const.color",
      properties: { value: [1, 1, 1, 1] },
    });
  });

  it("declares a new, uniquely named parameter for each Parameter node added without one", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [{ id: "first", name: "Parameter", type: "float", defaultValue: [1] }];
    doc.nodes.push(parameterNode("reader", "first"));
    const next = structuredClone(doc);
    next.nodes.push(parameterNode("new-color", "", "color"), parameterNode("new-float", "", "float"));
    const reconciled = reconcileParticleParameters(doc, next, { newId: ids() });
    expect(reconciled.parameters).toEqual([
      { id: "first", name: "Parameter", type: "float", defaultValue: [1] },
      { id: "p-1", name: "Parameter_1", type: "color", defaultValue: [1, 1, 1, 1] },
      { id: "p-2", name: "Parameter_2", type: "float", defaultValue: [0] },
    ]);
    expect(nodeOf(reconciled, "new-color").properties).toEqual({ parameterId: "p-1", valueType: "color" });
  });

  it("gives a copied or duplicated node its own parameter, leaving the original's", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [heat];
    doc.nodes.push(parameterNode("original", "heat"));
    // The copy lands first in order; the node that read it before keeps it.
    const next = { ...doc, nodes: [parameterNode("copy", "heat"), parameterNode("copy-2", "heat"), ...doc.nodes] };
    const reconciled = reconcileParticleParameters(doc, next, {
      newId: ids(),
      snapshots: new Map([["copy", { name: "Heat", type: "float" as const, defaultValue: [3] }]]),
    });
    expect(nodeOf(reconciled, "original").properties.parameterId).toBe("heat");
    expect(reconciled.parameters).toEqual([
      heat,
      { id: "p-1", name: "Heat_1", type: "float", defaultValue: [3] },
      // Without a snapshot the copy takes the parameter as it is now.
      { id: "p-2", name: "Heat_2", type: "float", defaultValue: [1] },
    ]);
    expect(nodeOf(reconciled, "copy").properties.parameterId).toBe("p-1");
    expect(nodeOf(reconciled, "copy-2").properties.parameterId).toBe("p-2");
  });

  it("drops a parameter when its node is deleted and keeps one that was never read", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [heat, { id: "spare", name: "Spare", type: "float", defaultValue: [1] }];
    doc.nodes.push(parameterNode("a", "heat"));
    const none = { ...doc, nodes: doc.nodes.filter((node) => node.type !== "input.parameter") };
    expect(reconcileParticleParameters(doc, none, { newId: ids() }).parameters.map((parameter) => parameter.id))
      .toEqual(["spare"]);
  });

  it("declares a pasted node's missing parameter again under a free name", () => {
    const empty = createDefaultParticleGraphDocument("Embers");
    const snapshot = { name: "Heat", type: "float" as const, defaultValue: [3] };
    const pasted = { ...empty, nodes: [...empty.nodes, parameterNode("copy", "heat-elsewhere")] };
    const snapshots = new Map([["copy", snapshot]]);
    expect(reconcileParticleParameters(empty, pasted, { newId: ids(), snapshots }).parameters)
      .toEqual([{ id: "heat-elsewhere", ...snapshot }]);

    // Into a graph that already has a Heat: its own parameter, renamed.
    const declared = { ...empty, parameters: [{ ...heat, id: "local" }], nodes: [...empty.nodes, parameterNode("mine", "local")] };
    const into = reconcileParticleParameters(declared, { ...declared, nodes: [...declared.nodes, parameterNode("copy", "heat-elsewhere")] }, {
      newId: ids(),
      snapshots,
    });
    expect(into.parameters.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "local", name: "Heat" },
      { id: "heat-elsewhere", name: "Heat_1" },
    ]);
    // Without a snapshot the node stays in error.
    expect(reconcileParticleParameters(empty, pasted, { newId: ids() }).parameters).toEqual([]);
  });

  it("reads snapshots defensively", () => {
    expect(particleParameterSnapshot({ name: " Heat ", type: "vec2", defaultValue: [4] })).toEqual({
      name: "Heat",
      type: "vec2",
      defaultValue: [4, 4],
    });
    expect(particleParameterSnapshot({ name: "", type: "float" })).toBeNull();
    expect(particleParameterSnapshot({ name: "Heat", type: "particle" })).toBeNull();
    expect(particleParameterSnapshot(null)).toBeNull();
  });

  it("edits a parameter, retyping its node and keeping names unique", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [heat, { id: "tint", name: "Tint", type: "color", defaultValue: [1, 0, 0, 1] }];
    doc.nodes.push(parameterNode("a", "heat"));
    const retyped = withParticleParameter(doc, { ...heat, type: "vec2" });
    expect(retyped.parameters[0]).toEqual({ id: "heat", name: "Heat", type: "vec2", defaultValue: [1, 1] });
    expect(nodeOf(retyped, "a").properties.valueType).toBe("vec2");
    expect(withParticleParameter(doc, { ...heat, name: "Tint" }).parameters[0]!.name).toBe("Tint_1");
  });
});
