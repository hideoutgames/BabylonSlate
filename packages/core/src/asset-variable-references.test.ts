import { describe, expect, it } from "vitest";
import { assetVariableGuidsFromGraph } from "./asset-variable-references";
import type { SerializedGraph } from "./project";

describe("assetVariableGuidsFromGraph", () => {
  it("collects scalar, array, Map key/value and local asset defaults without scanning strings", () => {
    const graph: SerializedGraph = { nodes: [], edges: [], members: [
      { id: "audio", kind: "variable", name: "Clip", typeId: "asset", typeClassId: "Audio", defaultValue: "clip" },
      { id: "models", kind: "variable", name: "Models", typeId: "asset", typeClassId: "Model", container: "array", defaultValue: ["model", "", { ignored: "unused" }] },
      { id: "map", kind: "variable", name: "Local", functionId: "paint", typeId: "asset", typeClassId: "Material", container: "map", keyTypeId: "asset", keyTypeClassId: "Font", defaultValue: [{ key: "font", value: "material" }] },
      { id: "labels", kind: "variable", name: "Labels", typeId: "string", container: "map", keyTypeId: "string", defaultValue: [{ key: "unused", value: "unused" }] },
      { id: "label", kind: "variable", name: "Label", typeId: "string", defaultValue: "unused" },
    ] };
    expect(assetVariableGuidsFromGraph(graph).sort()).toEqual(["clip", "font", "material", "model"]);
  });

  it("collects typed Set Variable literals in functions and respects cleared canonical defaults", () => {
    const setter = (id: string, properties: Record<string, unknown>) => ({ id, type: "variables.set", position: { x: 0, y: 0 }, data: { properties } });
    const graph: SerializedGraph = { nodes: [
      setter("legacy", { typeId: "asset", typeClassId: "Audio", variableName: "Clip", "default:Clip": "clip" }),
      setter("cleared", { typeId: "asset", "default:value": null, value: "unused" }),
      setter("string", { typeId: "string", "default:value": "unused" }),
    ], edges: [], functionGraphs: { paint: { nodes: [
      setter("map", { typeId: "asset", container: "map", keyTypeId: "string", "default:value": [{ key: "unused", value: "material" }] }),
    ], edges: [] } } };
    expect(assetVariableGuidsFromGraph(graph).sort()).toEqual(["clip", "material"]);
  });
});
