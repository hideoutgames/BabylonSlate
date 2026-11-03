import { describe, expect, it } from "vitest";
import { lowerParticleGraphDocument, validateParticleGraphDocument } from "@haptic/particle-graph";
import { sheetFlipbookGraph, surfaceSparksGraph } from "./particles";

describe("Feature Test Particle Graphs", () => {
  it("builds the flipbook and the surface sparks with no validation warnings and every authoring node on the spine", () => {
    const graphs = [sheetFlipbookGraph("FT_FxSheetGraph", "mat-sheet"), surfaceSparksGraph("FT_FxSurfaceSparksGraph", "mat-glow", "em-flash")];
    for (const graph of graphs) {
      expect(validateParticleGraphDocument(graph).map((entry) => `${entry.code} ${entry.nodeId ?? ""}`)).toEqual([]);
      expect(lowerParticleGraphDocument(graph).ok).toBe(true);
    }
    const types = new Set(graphs.flatMap((graph) => graph.nodes.map((node) => node.type)));
    for (const type of ["sprite.setup", "update.basicSprite", "shape.mesh", "update.noise", "math.nlerp", "utility.localVariable",
      "update.angleDegrees", "trigger.spawn"]) expect(types.has(type), type).toBe(true);
    const spawn = graphs[1]!.nodes.find((node) => node.type === "trigger.spawn")!;
    expect(spawn.properties).toMatchObject({ emitterGuid: "em-flash", limit: 4, minInterval: 0.25 });
    // On Death: a Condition node drives Spawn Emitter's Condition.
    const condition = graphs[1]!.edges.find((edge) => edge.targetNodeId === spawn.id && edge.targetPinId === "condition")!;
    expect(graphs[1]!.nodes.find((node) => node.id === condition.sourceNodeId)!.type).toBe("logic.condition");
  });
});
