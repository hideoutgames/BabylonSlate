import { describe, expect, it } from "vitest";
import {
  createDefaultParticleGraphDocument,
  type ParticleGraphDocument,
  type ParticleGraphEdge,
  type ParticleGraphNode,
} from "./document";
import { lowerParticleGraphDocument, particleGraphCompileKey, type ParticleBuildPlan } from "./lower";
import { listUnconnectedParticlePinDefaults } from "./pin-defaults";
import { collapseParticleReroutes } from "./reroute";
import { validateParticleGraphDocument } from "./validate";

function knot(id: string): ParticleGraphNode {
  return { id, type: "utility.reroute", position: { x: 0, y: 0 }, properties: {} };
}

function wire(id: string, source: string, sourcePin: string, target: string, targetPin: string): ParticleGraphEdge {
  return { id, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin };
}

/** The default graph with a Material, so a valid graph has no diagnostics but No Motion's absence. */
function graph(): ParticleGraphDocument {
  return { ...createDefaultParticleGraphDocument(), materialGuid: "mat" };
}

/** `doc` with the wire `edgeId` routed through `count` knots in a row. */
function throughKnots(doc: ParticleGraphDocument, edgeId: string, count: number): ParticleGraphDocument {
  const direct = doc.edges.find((edge) => edge.id === edgeId)!;
  const ids = Array.from({ length: count }, (_, index) => `${edgeId}-knot${index}`);
  const stops = [direct.sourceNodeId, ...ids, direct.targetNodeId];
  const pins = [direct.sourcePinId, ...ids.map(() => "out")];
  return {
    ...doc,
    nodes: [...doc.nodes, ...ids.map(knot)],
    edges: [
      ...doc.edges.filter((edge) => edge.id !== edgeId),
      ...ids.map((_, index) => wire(`${edgeId}-${index}`, stops[index]!, pins[index]!, stops[index + 1]!, "in")),
      wire(`${edgeId}-${count}`, stops[count]!, pins[count]!, direct.targetNodeId, direct.targetPinId),
    ],
  };
}

function plan(doc: ParticleGraphDocument): ParticleBuildPlan {
  const result = lowerParticleGraphDocument(doc);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

describe("particle Reroute knots", () => {
  it("leave a graph without knots untouched", () => {
    const doc = graph();
    expect(collapseParticleReroutes(doc)).toBe(doc);
  });

  it.each([1, 3])("build a value wire through %i knots exactly as the direct wire, with the same compile key", (count) => {
    const direct = graph();
    const routed = throughKnots(direct, "e-multiply-color", count);
    expect(plan(routed)).toEqual(plan(direct));
    expect(particleGraphCompileKey(routed)).toBe(particleGraphCompileKey(direct));
    expect(validateParticleGraphDocument(routed)).toEqual(validateParticleGraphDocument(direct));
  });

  it("carry the Particle spine", () => {
    const direct = graph();
    const routed = throughKnots(direct, "e-shape-velocity", 2);
    expect(plan(routed).hash).toBe(plan(direct).hash);
  });

  it("feed every input wired from one knot", () => {
    const direct = graph();
    direct.nodes.push({ id: "size", type: "update.size", position: { x: 0, y: 0 }, properties: {} });
    direct.edges = direct.edges.filter((edge) => edge.id !== "e-color-output");
    direct.edges.push(
      wire("e-color-size", "updateColor", "out", "size", "particle"),
      wire("e-size-output", "size", "out", "output", "particle"),
      wire("e-age-size", "normalizedAge", "out", "size", "size"),
    );
    const routed: ParticleGraphDocument = {
      ...direct,
      nodes: [...direct.nodes, knot("k")],
      edges: [
        ...direct.edges.filter((edge) => edge.id !== "e-age-gradient" && edge.id !== "e-age-size"),
        wire("a", "normalizedAge", "out", "k", "in"),
        wire("b", "k", "out", "gradient", "ratio"),
        wire("c", "k", "out", "size", "size"),
      ],
    };
    expect(plan(routed)).toEqual(plan(direct));
  });

  it("report nothing when dangling, and the input behind one keeps its default", () => {
    const unwired = graph();
    unwired.edges = unwired.edges.filter((edge) => edge.id !== "e-age-gradient");
    const dangling: ParticleGraphDocument = {
      ...unwired,
      nodes: [...unwired.nodes, knot("lead"), knot("loose")],
      edges: [...unwired.edges, wire("x", "lead", "out", "gradient", "ratio"), wire("y", "multiply", "out", "loose", "in")],
    };
    expect(validateParticleGraphDocument(dangling)).toEqual(validateParticleGraphDocument(unwired));
    expect(plan(dangling)).toEqual(plan(unwired));
    expect(listUnconnectedParticlePinDefaults(dangling, "gradient").map((row) => [row.pinId, row.value])).toEqual([
      ["ratio", [0]],
    ]);
  });

  it("report a type mismatch through a knot on the real target", () => {
    const doc = graph();
    doc.nodes.push({ id: "v3", type: "const.vec3", position: { x: 0, y: 0 }, properties: { value: [1, 2, 3] } }, knot("k"));
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-age-gradient");
    doc.edges.push(wire("a", "v3", "out", "k", "in"), wire("b", "k", "out", "gradient", "ratio"));
    expect(validateParticleGraphDocument(doc).filter((entry) => entry.severity === "error")).toEqual([
      expect.objectContaining({ code: "particle.typeMismatch", nodeId: "gradient", pinId: "ratio" }),
    ]);
  });

  it("report a second Particle branch fanned out through a knot on the real output", () => {
    const doc = graph();
    doc.nodes.push(knot("k"), { id: "spare", type: "update.size", position: { x: 0, y: 0 }, properties: {} });
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-create-shape");
    doc.edges.push(
      wire("a", "create", "out", "k", "in"),
      wire("b", "k", "out", "shape", "particle"),
      wire("c", "k", "out", "spare", "particle"),
    );
    expect(validateParticleGraphDocument(doc)).toContainEqual(
      expect.objectContaining({ code: "particle.spineFanOut", nodeId: "create", pinId: "out" }),
    );
  });
});
