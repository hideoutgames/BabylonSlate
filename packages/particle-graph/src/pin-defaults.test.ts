import { describe, expect, it } from "vitest";
import { createDefaultParticleGraphDocument } from "./document";
import { listUnconnectedParticlePinDefaults } from "./pin-defaults";

describe("particle pin defaults", () => {
  it("lists unconnected values at the resolved type and leaves out wired and Particle pins", () => {
    const doc = createDefaultParticleGraphDocument();
    doc.nodes.push(
      { id: "up", type: "const.vec3", position: { x: 0, y: 0 }, properties: { value: [0, 1, 0] } },
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: { "default:b": [2] } },
    );
    doc.edges.push({ id: "u", sourceNodeId: "up", sourcePinId: "out", targetNodeId: "add", targetPinId: "a" });
    expect(listUnconnectedParticlePinDefaults(doc, "add")).toEqual([
      { pinId: "b", name: "B", type: "vec3", value: [2, 2, 2] },
    ]);
    expect(listUnconnectedParticlePinDefaults(doc, "updateColor")).toEqual([]);
    expect(listUnconnectedParticlePinDefaults(doc, "output")).toEqual([
      expect.objectContaining({ pinId: "emitRate", name: "Emit Rate", type: "float", value: [30], min: 0 }),
    ]);
  });

  it("shows shape directions only once they are authored", () => {
    const doc = createDefaultParticleGraphDocument();
    const rows = () => listUnconnectedParticlePinDefaults(doc, "shape").map((row) => row.pinId);
    expect(rows()).not.toContain("direction1");
    doc.nodes.find((node) => node.id === "shape")!.properties["default:direction1"] = [0, 1, 0];
    expect(rows()).toContain("direction1");
  });
});
