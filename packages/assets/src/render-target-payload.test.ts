import { expect, it } from "vitest";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import { importBabasset } from "./importers/babasset";
import { remapImportResultGuids } from "./importers/guid-remap";
import { renderTargetAssetDependencies } from "./render-target-payload";

it("preserves the live sampler's target through save, load, and colliding cross-project import", async () => {
  const payload = { renderTargetGuid: "target-guid" };
  const dependencies = renderTargetAssetDependencies("RenderTargetTexture", payload);
  const textureBytes = await encodeAssetDocument({
    type: "RenderTargetTexture", name: "Depth Texture", guid: "texture-guid", version: 1, payload,
  }, { dependencies });
  expect((await decodeAssetDocument(textureBytes)).payload).toEqual(payload);
  const targetBytes = await encodeAssetDocument({
    type: "RenderTarget", name: "Depth", guid: "target-guid", version: 1,
    payload: { mode: "DepthPass", width: 256, height: 128 },
  });
  const imported = [
    ...await importBabasset(targetBytes, { fileName: "Depth.rendertarget.babasset", existingGuids: new Set() }),
    ...await importBabasset(textureBytes, { fileName: "Depth Texture.rendertargettexture.babasset", existingGuids: new Set() }),
  ];
  const remapped = remapImportResultGuids(imported, new Set(["target-guid"]));
  const target = remapped.find((asset) => asset.type === "RenderTarget")!;
  const texture = remapped.find((asset) => asset.type === "RenderTargetTexture")!;
  expect(target.guid).not.toBe("target-guid");
  expect(texture.dependencies).toEqual([target.guid]);
  const chunk = texture.chunks.find((entry) => entry.id === "document")!;
  expect(JSON.parse(new TextDecoder().decode(chunk.data)).renderTargetGuid).toBe(target.guid);
});


it("remaps colliding captures across scenes, graph defaults and material samplers without rewriting text", async () => {
  const targetGuid = "target-collision";
  const textureGuid = "image-collision";
  const capture = { id: "capture", classId: "RenderTargetCaptureComponent", properties: { renderTargetGuid: targetGuid, actorIds: ["subject"] } };
  const documents = [
    { type: "RenderTarget", guid: targetGuid, payload: { mode: "SceneColor", width: 128, height: 128 } },
    { type: "RenderTargetTexture", guid: textureGuid, payload: { renderTargetGuid: targetGuid } },
    { type: "Scene", guid: "scene", payload: { actors: [{ id: "monitor", classId: "RenderTargetCapture", components: [capture] }] } },
    { type: "Class", guid: "graph", payload: { components: [capture], nodes: [
      { type: "render-target.getMode", data: { properties: { "default:target": targetGuid } } },
      { type: "variables.set", data: { properties: { typeId: "asset", typeClassId: "RenderTarget", propertyKey: "renderTargetGuid", "default:value": targetGuid } } },
      { type: "variables.set", data: { properties: { typeId: "asset", typeClassId: "RenderTargetTexture", container: "array", "default:value": [textureGuid] } } },
      { type: "variables.set", data: { properties: { typeId: "string", "default:value": targetGuid } } },
    ], members: [
      { kind: "variable", typeId: "asset", typeClassId: "RenderTarget", defaultValue: targetGuid },
      { kind: "variable", typeId: "asset", typeClassId: "Texture", container: "map", keyTypeId: "asset", keyTypeClassId: "RenderTarget", defaultValue: [{ key: targetGuid, value: textureGuid }] },
    ], functionGraphs: { sample: { nodes: [
      { type: "render-target.getTextureTarget", data: { "default:texture": textureGuid } },
      { type: "material.setTextureParameter", data: { properties: { "default:value": textureGuid } } },
    ] } } } },
    { type: "Material", guid: "material", payload: { nodes: [{ type: "texture.sample", properties: { textureGuid } }], label: textureGuid } },
  ];
  const imports = [];
  for (const document of documents) {
    const bytes = await encodeAssetDocument({ ...document, name: document.guid, version: 1, payload: document.payload as Record<string, unknown> }, {
      dependencies: document.type === "RenderTarget" ? [] : [targetGuid, textureGuid],
    });
    imports.push(...await importBabasset(bytes, { fileName: `${document.guid}.babasset`, existingGuids: new Set() }));
  }
  const remapped = remapImportResultGuids(imports, new Set([targetGuid, textureGuid]));
  const target = remapped.find((asset) => asset.type === "RenderTarget")!.guid;
  const image = remapped.find((asset) => asset.type === "RenderTargetTexture")!.guid;
  expect(target).not.toBe(targetGuid);
  expect(image).not.toBe(textureGuid);
  const body = (type: string) => JSON.parse(new TextDecoder().decode(remapped.find((asset) => asset.type === type)!.chunks.find((chunk) => chunk.id === "document")!.data));
  expect(body("Scene").actors[0].components[0].properties).toEqual({ renderTargetGuid: target, actorIds: ["subject"] });
  expect(body("RenderTargetTexture").renderTargetGuid).toBe(target);
  const graph = body("Class");
  expect(graph.components[0].properties.renderTargetGuid).toBe(target);
  expect(graph.nodes[0].data.properties["default:target"]).toBe(target);
  expect(graph.nodes[1].data.properties["default:value"]).toBe(target);
  expect(graph.nodes[2].data.properties["default:value"]).toEqual([image]);
  expect(graph.nodes[3].data.properties["default:value"]).toBe(targetGuid);
  expect(graph.members.map((member: { defaultValue: unknown }) => member.defaultValue)).toEqual([target, [{ key: target, value: image }]]);
  expect(graph.functionGraphs.sample.nodes[0].data["default:texture"]).toBe(image);
  expect(graph.functionGraphs.sample.nodes[1].data.properties["default:value"]).toBe(image);
  expect(body("Material")).toMatchObject({ nodes: [{ properties: { textureGuid: image } }], label: textureGuid });
  expect(capture.properties.renderTargetGuid).toBe(targetGuid);
});
