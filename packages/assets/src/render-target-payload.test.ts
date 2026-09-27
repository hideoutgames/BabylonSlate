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
