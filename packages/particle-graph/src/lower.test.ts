import { describe, expect, it } from "vitest";
import {
  createDefaultParticleGraphDocument,
  normalizeParticleGraphDocument,
  type ParticleGraphDocument,
  type ParticleGraphNode,
} from "./document";
import {
  lowerParticleGraphDocument,
  particleGraphCompileKey,
  type ParticleBuildPlan,
} from "./lower";

function plan(doc: ParticleGraphDocument): ParticleBuildPlan {
  const result = lowerParticleGraphDocument(doc);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.plan;
}

function edited(edit: (doc: ParticleGraphDocument) => void): ParticleGraphDocument {
  const doc = createDefaultParticleGraphDocument();
  edit(doc);
  return doc;
}

function nodeOf(doc: ParticleGraphDocument, id: string): ParticleGraphNode {
  return doc.nodes.find((node) => node.id === id)!;
}

function operation(result: ParticleBuildPlan, id: string) {
  return result.operations.find((entry) => entry.id === id)!;
}

describe("particle graph lowering", () => {
  it("orders operations topologically and lists the spine in update-queue order", () => {
    const result = plan(createDefaultParticleGraphDocument());
    const seen = new Set<string>();
    for (const entry of result.operations) {
      for (const operand of Object.values(entry.inputs)) {
        if (operand.kind === "operation") expect(seen.has(operand.operationId), entry.id).toBe(true);
      }
      seen.add(entry.id);
    }
    expect(result.spine).toEqual(["create", "shape", "velocity", "updateColor", "output"]);
    expect(result.operations.at(-1)?.id).toBe("output");
    expect(operation(result, "velocity").resolvedType).toBe("particle");
  });

  it("does not depend on the order of the node array", () => {
    const doc = createDefaultParticleGraphDocument();
    const reversed = { ...doc, nodes: [...doc.nodes].reverse(), edges: [...doc.edges].reverse() };
    expect(plan(reversed).operations.map((entry) => entry.id)).toEqual(plan(doc).operations.map((entry) => entry.id));
    expect(plan(reversed).hash).toBe(plan(doc).hash);
  });

  it("keeps the hash across layout, name, Material, stray nodes and defaults behind wires", () => {
    const hash = plan(createDefaultParticleGraphDocument()).hash;
    const same = [
      edited((doc) => (nodeOf(doc, "shape").position = { x: -500, y: 90 })),
      edited((doc) => (doc.name = "Sparks")),
      edited((doc) => (doc.materialGuid = "mat-1")),
      edited((doc) =>
        doc.nodes.push({ id: "stray", type: "const.float", position: { x: 0, y: 0 }, properties: { value: [4] } }),
      ),
      edited((doc) => (nodeOf(doc, "updateColor").properties["default:color"] = [1, 0, 0, 1])),
    ];
    for (const doc of same) expect(plan(doc).hash).toBe(hash);

    const changed = [
      edited((doc) => (nodeOf(doc, "gradient").properties.stops = [
        { position: 0, value: [1, 0, 0, 1] },
        { position: 1, value: [1, 1, 1, 0] },
      ])),
      edited((doc) => (nodeOf(doc, "create").properties["default:size"] = [0.5])),
      edited((doc) => (doc.settings.loop = "once")),
    ];
    for (const doc of changed) expect(plan(doc).hash).not.toBe(hash);
  });

  it("marks Float wires into vectors as splats and widens Float defaults", () => {
    const doc = normalizeParticleGraphDocument({
      nodes: [
        ...createDefaultParticleGraphDocument().nodes,
        { id: "time", type: "input.system.time" },
        { id: "offset", type: "math.add" },
        { id: "up", type: "const.vec3", properties: { value: [0, 1, 0] } },
        { id: "sum", type: "math.add" },
        { id: "place", type: "update.position" },
      ],
      edges: [
        ...createDefaultParticleGraphDocument().edges.filter((edge) => edge.id !== "e-color-output"),
        { id: "t", sourceNodeId: "time", sourcePinId: "out", targetNodeId: "offset", targetPinId: "a" },
        { id: "u", sourceNodeId: "up", sourcePinId: "out", targetNodeId: "sum", targetPinId: "a" },
        { id: "o", sourceNodeId: "offset", sourcePinId: "out", targetNodeId: "sum", targetPinId: "b" },
        { id: "s", sourceNodeId: "sum", sourcePinId: "out", targetNodeId: "place", targetPinId: "position" },
        { id: "c", sourceNodeId: "updateColor", sourcePinId: "out", targetNodeId: "place", targetPinId: "particle" },
        { id: "p", sourceNodeId: "place", sourcePinId: "out", targetNodeId: "output", targetPinId: "particle" },
      ],
    });
    const result = plan(doc);
    expect(operation(result, "sum").resolvedType).toBe("vec3");
    expect(operation(result, "sum").inputs.b).toEqual({
      kind: "operation",
      operationId: "offset",
      pinId: "out",
      conversion: { kind: "splat", from: "float", to: "vec3" },
    });
    // Offset has only a Float input, so its unwired B stays a Float constant.
    expect(operation(result, "offset").inputs.b).toEqual({ kind: "constant", type: "float", value: [0] });

    const widened = normalizeParticleGraphDocument({
      ...doc,
      edges: doc.edges.filter((edge) => edge.id !== "o"),
    });
    expect(operation(plan(widened), "sum").inputs.b).toEqual({ kind: "constant", type: "vec3", value: [0, 0, 0] });
  });

  it("prepends a stop at 0 so Babylon never samples below the first stop", () => {
    const doc = edited((entry) => (nodeOf(entry, "gradient").properties.stops = [
      { position: 0.3, value: [1, 0, 0, 1] },
      { position: 1, value: [0, 0, 1, 0] },
    ]));
    expect(operation(plan(doc), "gradient").properties.stops).toEqual([
      { position: 0, value: [1, 0, 0, 1] },
      { position: 0.3, value: [1, 0, 0, 1] },
      { position: 1, value: [0, 0, 1, 0] },
    ]);
  });

  it("clamps constants to the pin range, so Lifetime never divides by zero", () => {
    const doc = edited((entry) => (nodeOf(entry, "create").properties["default:lifetime"] = [0]));
    expect(operation(plan(doc), "create").inputs.lifetime).toEqual({ kind: "constant", type: "float", value: [0.01] });
  });

  it("lowers authored shape directions as operands and leaves unset ones out", () => {
    const radial = plan(createDefaultParticleGraphDocument());
    expect(operation(radial, "shape").inputs).not.toHaveProperty("direction1");
    const directed = edited((doc) => {
      nodeOf(doc, "shape").properties["default:direction1"] = [0, 1, 0];
      nodeOf(doc, "shape").properties["default:direction2"] = [0.2, 1, 0];
    });
    expect(operation(plan(directed), "shape").inputs).toMatchObject({
      direction1: { kind: "constant", type: "vec3", value: [0, 1, 0] },
      direction2: { kind: "constant", type: "vec3", value: [0.2, 1, 0] },
    });
  });

  it("refuses invalid graphs and keys them without positions", () => {
    const broken = edited((doc) => {
      doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    });
    expect(lowerParticleGraphDocument(broken)).toMatchObject({ ok: false });
    const key = particleGraphCompileKey(broken);
    expect(key.startsWith("invalid:")).toBe(true);
    const moved = { ...broken, nodes: broken.nodes.map((node) => ({ ...node, position: { x: node.position.x + 40, y: 7 } })) };
    expect(particleGraphCompileKey(moved)).toBe(key);
    expect(particleGraphCompileKey({ ...broken, settings: { ...broken.settings, capacity: 64 } })).not.toBe(key);
  });
});
