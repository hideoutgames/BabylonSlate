import { describe, expect, it } from "vitest";
import type { GlobalParameterCatalog } from "@haptic/core";
import { createDefaultParticleGraphDocument, type ParticleGraphDocument } from "./document";
import { PARTICLE_OUTPUT_NODE_TYPE } from "./catalog";
import { selectParticleGlobalParameter } from "./global-parameter";
import { hydrateParticleGraphForEditor, particleGraphToSerialized, particlePaletteNodes } from "./serialize-particle-graph";
import { validateParticleGraphDocument } from "./validate";

const catalog: GlobalParameterCatalog = {
  fx: [
    { id: "wind", name: "Wind Strength", type: "float", defaultValue: [1] },
    { id: "tint", name: "Sky Tint", type: "color", defaultValue: [1, 1, 1, 1] },
    { id: "rect", name: "Rect", type: "vec4", defaultValue: [0, 0, 1, 1] },
  ],
};

/** The default graph with a Global Parameter node, wired into the Emitter Output's Emit Rate when `wired`. */
function graph(properties: Record<string, unknown>, wired = false): ParticleGraphDocument {
  const doc = createDefaultParticleGraphDocument();
  const output = doc.nodes.find((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE)!;
  doc.nodes.push({ id: "global", type: "global.parameter", position: { x: 0, y: 0 }, properties });
  if (wired) doc.edges.push({ id: "global-rate", sourceNodeId: "global", sourcePinId: "out", targetNodeId: output.id, targetPinId: "emitRate" });
  return doc;
}

function hydrated(doc: ParticleGraphDocument, globalParameters?: GlobalParameterCatalog) {
  const node = hydrateParticleGraphForEditor(particleGraphToSerialized(doc), [], globalParameters)
    .nodes.find((entry) => entry.id === "global")!;
  const data = node.data as { title: string; __pins: { id: string; direction: string; type: { kind: string } }[] };
  return { title: data.title, outputs: data.__pins.filter((pin) => pin.direction === "out").map((pin) => `${pin.id}:${pin.type.kind}`) };
}

describe("Particle Graph Global Parameter node", () => {
  it("is offered under Parameter in Add Node", () => {
    expect(particlePaletteNodes().find((node) => node.id === "global.parameter")).toMatchObject({
      title: "Global Parameter",
      category: "Parameter",
    });
  });

  it("is named after its parameter and typed by it; without a parameter it has no output", () => {
    expect(hydrated(graph({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }), catalog))
      .toEqual({ title: "Sky Tint (Global Color)", outputs: ["out:color"] });
    expect(hydrated(graph({ collectionGuid: "fx", parameterId: "wind", valueType: "float" }), catalog))
      .toEqual({ title: "Wind Strength (Global Float)", outputs: ["out:float"] });
    expect(hydrated(graph({ collectionGuid: "fx" }), catalog)).toEqual({ title: "Global Parameter", outputs: [] });
  });

  it("reads a Vector4 on the graph's Color type, its only four-component type, and keeps the parameter's own type on the node", () => {
    const doc = selectParticleGlobalParameter(graph({ collectionGuid: "fx" }), "global", "fx", { id: "rect", type: "vec4" });
    expect(doc.nodes.find((node) => node.id === "global")?.properties).toEqual({ collectionGuid: "fx", parameterId: "rect", valueType: "vec4" });
    expect(hydrated(doc, catalog)).toEqual({ title: "Rect (Global Vector4)", outputs: ["out:color"] });
    expect(validateParticleGraphDocument(doc, { globalParameters: catalog }).filter((row) => row.code === "particle.globalParameter")).toEqual([]);
  });

  it("keeps its wires on a new parameter and drops them without one", () => {
    const doc = graph({ collectionGuid: "fx", parameterId: "wind", valueType: "float" }, true);
    const retyped = selectParticleGlobalParameter(doc, "global", "fx", { id: "tint", type: "color" });
    expect(retyped.nodes.find((node) => node.id === "global")?.properties).toEqual({ collectionGuid: "fx", parameterId: "tint", valueType: "color" });
    expect(retyped.edges.some((edge) => edge.id === "global-rate")).toBe(true);
    const cleared = selectParticleGlobalParameter(doc, "global", "fx", null);
    expect(cleared.nodes.find((node) => node.id === "global")?.properties).toEqual({ collectionGuid: "fx" });
    expect(cleared.edges.some((edge) => edge.sourceNodeId === "global")).toBe(false);
  });

  it("warns when it has no parameter, or its parameter is gone or retyped", () => {
    const warnings = (properties: Record<string, unknown>) => validateParticleGraphDocument(graph(properties), { globalParameters: catalog })
      .filter((row) => row.code === "particle.globalParameter")
      .map((row) => `${row.severity}: ${row.message}`);
    expect(warnings({ collectionGuid: "fx", parameterId: "wind", valueType: "float" })).toEqual([]);
    expect(warnings({})).toEqual(["warning: Global Parameter has no parameter selected"]);
    expect(warnings({ collectionGuid: "fx", parameterId: "gone", valueType: "float" }))
      .toEqual(["warning: Global Parameter's parameter is no longer in its collection; it reads 0"]);
    expect(warnings({ collectionGuid: "fx", parameterId: "tint", valueType: "float" }))
      .toEqual(["warning: \"Sky Tint\" is now a Color parameter; select it again to update this node"]);
  });
});
