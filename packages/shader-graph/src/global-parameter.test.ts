import { describe, expect, it } from "vitest";
import type { GlobalParameterCatalog } from "@haptic/core";
import { createDefaultMaterialDocument, materialDependencies, type MaterialDocument } from "./document";
import { selectMaterialGlobalParameter } from "./global-parameter";
import { lowerMaterialDocument } from "./lower";
import { hydrateMaterialGraphForEditor, materialGraphToSerialized, materialPaletteNodes } from "./serialize-material";
import { validateMaterialDocument } from "./validate";

const catalog: GlobalParameterCatalog = {
  fx: [
    { id: "tint", name: "Sky Tint", type: "color", defaultValue: [1, 1, 1, 1] },
    { id: "wind", name: "Wind Direction", type: "vec3", defaultValue: [1, 0, 0] },
  ],
};

/** A Surface Material with one Global Parameter node, wired from `pin` into Base Color when given. */
function material(properties: Record<string, unknown>, pin?: string): MaterialDocument {
  const document = createDefaultMaterialDocument();
  document.nodes.push({ id: "global", type: "global.parameter", position: { x: 0, y: 0 }, properties });
  if (pin) {
    document.edges = [
      ...document.edges.filter((edge) => edge.targetPinId !== "baseColor"),
      { id: "global-base", sourceNodeId: "global", sourcePinId: pin, targetNodeId: "output", targetPinId: "baseColor" },
    ];
  }
  return document;
}

function hydrated(document: MaterialDocument, globalParameters?: GlobalParameterCatalog) {
  const node = hydrateMaterialGraphForEditor(materialGraphToSerialized(document), { globalParameters })
    .nodes.find((entry) => entry.id === "global")!;
  const data = node.data as { title: string; __pins: { id: string; direction: string; type: { kind: string } }[] };
  return { title: data.title, outputs: data.__pins.filter((pin) => pin.direction === "out").map((pin) => `${pin.id}:${pin.type.kind}`) };
}

describe("Material Global Parameter node", () => {
  it("is offered under Parameter in Add Node", () => {
    expect(materialPaletteNodes("surface").find((node) => node.id === "global.parameter")).toMatchObject({
      title: "Global Parameter",
      category: "Parameter",
    });
  });

  it("is named after its parameter and takes its type's outputs; without a parameter it has none", () => {
    expect(hydrated(material({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }), catalog))
      .toEqual({ title: "Sky Tint (Global Color)", outputs: ["out:vec4", "rgb:vec3"] });
    expect(hydrated(material({ collectionGuid: "fx", parameterId: "wind", valueType: "vec3" }), catalog))
      .toEqual({ title: "Wind Direction (Global Vector3)", outputs: ["out:vec3"] });
    expect(hydrated(material({ collectionGuid: "fx" }), catalog)).toEqual({ title: "Global Parameter", outputs: [] });
    // Without the project's collections the node keeps its type but cannot name it.
    expect(hydrated(material({ collectionGuid: "fx", parameterId: "wind", valueType: "float" })))
      .toEqual({ title: "Global Parameter", outputs: ["out:float"] });
  });

  it("lowers to an operation that carries its selection and no value", () => {
    const lowered = lowerMaterialDocument(material({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }, "rgb"));
    if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
    const operation = lowered.plan.operations.find((entry) => entry.nodeType === "global.parameter");
    expect(operation?.properties).toEqual({ collectionGuid: "fx", parameterId: "tint", valueType: "color" });
    expect(operation?.resolvedType).toBe("vec4");
  });

  it("drops wires from outputs the new selection lacks", () => {
    const color = material({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }, "rgb");
    // Color → Vector3: RGB is gone.
    const vector = selectMaterialGlobalParameter(color, "global", "fx", { id: "wind", type: "vec3" });
    expect(vector.nodes.find((node) => node.id === "global")?.properties).toEqual({ collectionGuid: "fx", parameterId: "wind", valueType: "vec3" });
    expect(vector.edges.some((edge) => edge.sourceNodeId === "global")).toBe(false);
    // A Vector3's Out stays wired when it becomes a Color.
    const wired = material({ collectionGuid: "fx", parameterId: "wind", valueType: "vec3" }, "out");
    expect(selectMaterialGlobalParameter(wired, "global", "fx", { id: "tint", type: "color" }).edges.some((edge) => edge.id === "global-base")).toBe(true);
    // The collection alone leaves no outputs; no collection clears the node.
    expect(selectMaterialGlobalParameter(wired, "global", "fx", null).edges.some((edge) => edge.sourceNodeId === "global")).toBe(false);
    expect(selectMaterialGlobalParameter(wired, "global", "  ", null).nodes.find((node) => node.id === "global")?.properties).toEqual({});
  });

  it("warns when it has no parameter, or its parameter is gone or retyped", () => {
    const warnings = (properties: Record<string, unknown>) => validateMaterialDocument(material(properties), { globalParameters: catalog })
      .filter((row) => row.code === "material.globalParameter")
      .map((row) => `${row.severity}: ${row.message}`);
    expect(warnings({ collectionGuid: "fx", parameterId: "tint", valueType: "color" })).toEqual([]);
    expect(warnings({ collectionGuid: "fx" })).toEqual(["warning: Global Parameter has no parameter selected"]);
    expect(warnings({ collectionGuid: "gone", parameterId: "tint", valueType: "color" }))
      .toEqual(["warning: Global Parameter's collection is missing; it reads 0"]);
    expect(warnings({ collectionGuid: "fx", parameterId: "gone", valueType: "color" }))
      .toEqual(["warning: Global Parameter's parameter is no longer in its collection; it reads 0"]);
    expect(warnings({ collectionGuid: "fx", parameterId: "wind", valueType: "float" }))
      .toEqual(["warning: \"Wind Direction\" is now a Vector3 parameter; select it again to update this node"]);
  });

  it("depends on the collection it reads, so Play and exports carry it", () => {
    const dependencies = materialDependencies(material({ collectionGuid: "fx", parameterId: "tint", valueType: "color" }));
    expect(dependencies.globalParameterCollections).toEqual(["fx"]);
    expect(dependencies.all).toContain("fx");
  });
});
