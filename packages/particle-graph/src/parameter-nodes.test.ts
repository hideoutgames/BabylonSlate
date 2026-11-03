import { describe, expect, it } from "vitest";
import {
  createDefaultParticleGraphDocument,
  type ParticleGraphDocument,
  type ParticleGraphNode,
} from "./document";
import {
  bindParticleParameterNode,
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

describe("particle parameter nodes", () => {
  it("names the Constant types and picks the first free parameter name", () => {
    expect(particleConstantValueType("const.color")).toBe("color");
    expect(particleConstantValueType("input.parameter")).toBeNull();
    const taken = [{ id: "a", name: "Parameter", type: "float" as const, defaultValue: [0] },
      { id: "b", name: "Parameter 2", type: "float" as const, defaultValue: [0] }];
    expect(uniqueParticleParameterName(taken)).toBe("Parameter 3");
    expect(uniqueParticleParameterName(taken, "Heat")).toBe("Heat");
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
    expect(convertParticleConstantToParameter(doc, "velocity", ids())).toBeNull();
  });

  it("converts a Parameter back to a Constant of its default and drops the parameter once no node reads it", () => {
    const doc = convertParticleConstantToParameter(withConstant(), "push", ids())!;
    doc.nodes.push(parameterNode("twin", "p-1"));
    const once = convertParticleParameterToConstant(doc, "twin")!;
    expect(nodeOf(once, "twin")).toMatchObject({ type: "const.float", properties: { value: [2.5] } });
    // Another node still reads it.
    expect(once.parameters.map((parameter) => parameter.id)).toEqual(["p-1"]);
    const twice = convertParticleParameterToConstant(once, "push")!;
    expect(twice.parameters).toEqual([]);
    expect(twice.edges).toEqual(doc.edges);
    expect(convertParticleParameterToConstant(doc, "velocity")).toBeNull();
  });

  it("converts a Parameter whose parameter is gone to its type's starting Constant", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.nodes.push(parameterNode("lost", "gone", "color"));
    expect(nodeOf(convertParticleParameterToConstant(doc, "lost")!, "lost")).toMatchObject({
      type: "const.color",
      properties: { value: [1, 1, 1, 1] },
    });
  });

  it("declares a new parameter for each Parameter node added without one", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [{ id: "heat", name: "Parameter", type: "float", defaultValue: [1] }];
    doc.nodes.push(parameterNode("reader", "heat"));
    const next = structuredClone(doc);
    next.nodes.push(parameterNode("new-color", "", "color"), parameterNode("new-float", "", "float"));
    const reconciled = reconcileParticleParameters(doc, next, { newId: ids() });
    expect(reconciled.parameters).toEqual([
      { id: "heat", name: "Parameter", type: "float", defaultValue: [1] },
      { id: "p-1", name: "Parameter 2", type: "color", defaultValue: [1, 1, 1, 1] },
      { id: "p-2", name: "Parameter 3", type: "float", defaultValue: [0] },
    ]);
    expect(nodeOf(reconciled, "new-color").properties).toEqual({ parameterId: "p-1", valueType: "color" });
  });

  it("drops a parameter when its last node is deleted and keeps one that was never read", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [
      { id: "heat", name: "Heat", type: "float", defaultValue: [1] },
      { id: "spare", name: "Spare", type: "float", defaultValue: [1] },
    ];
    doc.nodes.push(parameterNode("a", "heat"), parameterNode("b", "heat"));
    const oneLeft = { ...doc, nodes: doc.nodes.filter((node) => node.id !== "a") };
    expect(reconcileParticleParameters(doc, oneLeft, { newId: ids() }).parameters.map((parameter) => parameter.id))
      .toEqual(["heat", "spare"]);
    const none = { ...doc, nodes: doc.nodes.filter((node) => node.type !== "input.parameter") };
    expect(reconcileParticleParameters(doc, none, { newId: ids() }).parameters.map((parameter) => parameter.id))
      .toEqual(["spare"]);
  });

  it("brings a pasted node's parameter back, or reads the declared one of that name and type", () => {
    const empty = createDefaultParticleGraphDocument("Embers");
    const heat = { name: "Heat", type: "float" as const, defaultValue: [3] };
    const pasted = { ...empty, nodes: [...empty.nodes, parameterNode("copy", "heat-elsewhere")] };
    const restored = reconcileParticleParameters(empty, pasted, {
      newId: ids(),
      snapshots: new Map([["copy", heat]]),
    });
    expect(restored.parameters).toEqual([{ id: "heat-elsewhere", ...heat }]);

    const declared = { ...empty, parameters: [{ id: "local", name: "Heat", type: "float" as const, defaultValue: [1] }] };
    const intoDeclared = reconcileParticleParameters(declared, { ...declared, nodes: pasted.nodes }, {
      newId: ids(),
      snapshots: new Map([["copy", heat]]),
    });
    expect(intoDeclared.parameters.map((parameter) => parameter.id)).toEqual(["local"]);
    expect(nodeOf(intoDeclared, "copy").properties.parameterId).toBe("local");

    // Same name, other type: declared again under a free name.
    const otherType = reconcileParticleParameters(declared, { ...declared, nodes: pasted.nodes }, {
      newId: ids(),
      snapshots: new Map([["copy", { ...heat, type: "color" as const, defaultValue: [1, 0, 0, 1] }]]),
    });
    expect(otherType.parameters.map(({ id, name, type }) => ({ id, name, type }))).toEqual([
      { id: "local", name: "Heat", type: "float" },
      { id: "heat-elsewhere", name: "Heat 2", type: "color" },
    ]);
    expect(nodeOf(otherType, "copy").properties.valueType).toBe("color");
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

  it("rebinds a node and edits a parameter for every node that reads it", () => {
    const doc = createDefaultParticleGraphDocument("Embers");
    doc.parameters = [
      { id: "heat", name: "Heat", type: "float", defaultValue: [1] },
      { id: "tint", name: "Tint", type: "color", defaultValue: [1, 0, 0, 1] },
    ];
    doc.nodes.push(parameterNode("a", "heat"), parameterNode("b", "heat"));
    const retyped = withParticleParameter(doc, { ...doc.parameters[0]!, type: "vec2" });
    expect(retyped.parameters[0]).toEqual({ id: "heat", name: "Heat", type: "vec2", defaultValue: [1, 1] });
    expect(["a", "b"].map((id) => nodeOf(retyped, id).properties.valueType)).toEqual(["vec2", "vec2"]);

    const rebound = bindParticleParameterNode(doc, "a", "tint")!;
    expect(nodeOf(rebound, "a").properties).toEqual({ parameterId: "tint", valueType: "color" });
    expect(rebound.parameters.map((parameter) => parameter.id)).toEqual(["heat", "tint"]);
    const both = bindParticleParameterNode(rebound, "b", "tint")!;
    expect(both.parameters.map((parameter) => parameter.id)).toEqual(["tint"]);
    expect(bindParticleParameterNode(doc, "a", "missing")).toBeNull();
  });
});
