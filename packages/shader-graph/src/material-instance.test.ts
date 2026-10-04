import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, type MaterialDocument } from "./document";
import { lowerMaterialDocument } from "./lower";
import { materialParameterDefaults } from "./material-parameter-catalog";
import {
  createDefaultMaterialInstanceDocument,
  materialInstanceDependencies,
  materializeMaterialInstances,
  normalizeMaterialInstanceDocument,
  resolveMaterialInstance,
  type MaterialInstanceDocument,
  type MaterialSource,
} from "./material-instance";

function parentMaterial(): MaterialDocument {
  const document = createDefaultMaterialDocument("Parent");
  document.nodes.push(
    { id: "tint", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint", value: [1, 1, 1, 1] } },
    { id: "rough", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Roughness", value: [0.5] } },
    { id: "albedo", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "tex-a" } },
  );
  document.edges = [
    { id: "tint-base", sourceNodeId: "tint", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
    { id: "rough-out", sourceNodeId: "rough", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" },
  ];
  return document;
}

function instance(parentGuid: string | null, overrides: MaterialInstanceDocument["overrides"]): MaterialInstanceDocument {
  return { ...createDefaultMaterialInstanceDocument("Instance", parentGuid), overrides };
}

function lookupFrom(sources: Record<string, MaterialSource>) {
  return (guid: string) => sources[guid] ?? null;
}

describe("material instances", () => {
  it("merges overrides down a parent chain with the nearest instance winning", () => {
    const resolved = resolveMaterialInstance("child", lookupFrom({
      root: { kind: "material", document: parentMaterial() },
      base: { kind: "instance", document: instance("root", { Tint: { kind: "color", value: [1, 0, 0, 1] }, Roughness: { kind: "float", value: 0.2 } }) },
      child: { kind: "instance", document: instance("base", { Roughness: { kind: "float", value: 0.9 } }) },
    }));
    expect(resolved).toMatchObject({
      ok: true,
      rootGuid: "root",
      chain: ["child", "base", "root"],
      overrides: { Tint: { kind: "color", value: [1, 0, 0, 1] }, Roughness: { kind: "float", value: 0.9 } },
    });
  });

  it("rejects missing parents and parent cycles", () => {
    expect(resolveMaterialInstance("a", lookupFrom({ a: { kind: "instance", document: instance(null, {}) } })))
      .toMatchObject({ ok: false, code: "materialInstance.missingParent" });
    expect(resolveMaterialInstance("a", lookupFrom({
      a: { kind: "instance", document: instance("b", {}) },
      b: { kind: "instance", document: instance("a", {}) },
    }))).toMatchObject({ ok: false, code: "materialInstance.cycle" });
  });

  it("materializes parameter values without changing the parent graph's shader", () => {
    const parent = parentMaterial();
    const documents = materializeMaterialInstances(new Map([["root", parent]]), new Map([["inst", instance("root", {
      Tint: { kind: "color", value: [0, 1, 0, 1] },
      Albedo: { kind: "texture", textureAssetGuid: "tex-b" },
      Roughness: { kind: "color", value: [1, 1, 1, 1] },
      Missing: { kind: "float", value: 3 },
    })]]));
    const materialized = documents.get("inst")!;
    expect(materialized.instanceOf).toBe("root");
    expect(materialized.edges).toEqual(parent.edges);
    const plan = lowerMaterialDocument(materialized);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(materialParameterDefaults(plan.plan)).toEqual({
      Tint: { kind: "color", value: [0, 1, 0, 1] },
      // A kind mismatch keeps the parent's default rather than breaking the graph.
      Roughness: { kind: "float", value: 0.5 },
    });
    expect(materialized.nodes.find((node) => node.id === "albedo")?.properties.textureGuid).toBe("tex-b");
  });

  it("normalizes payloads and reports the parent and texture overrides as dependencies", () => {
    const doc = normalizeMaterialInstanceDocument({
      parentGuid: " root ",
      overrides: { Albedo: { kind: "texture", textureAssetGuid: "tex-b" }, Bad: { kind: "float", value: "x" } },
    });
    expect(doc).toMatchObject({ kind: "materialInstance", name: "Material Instance", parentGuid: "root", overrides: { Albedo: { kind: "texture", textureAssetGuid: "tex-b" } } });
    expect(doc.overrides).not.toHaveProperty("Bad");
    expect(materialInstanceDependencies(doc)).toEqual({ parent: "root", textures: ["tex-b"], all: ["root", "tex-b"] });
  });
});
